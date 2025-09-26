const { pool } = require('../config/database');
const axios = require('axios');

// --- Sanitization Utility ---
function sanitizeText(input) {
    if (typeof input !== 'string') return '';
    return input
        .replace(/[<>]/g, '') // remove HTML tags
        .replace(/['";]/g, '') // remove quotes & semicolons
        .trim();
}

const validators = {
    isValidAadhar: (aadhar) => /^[0-9]{12}$/.test(aadhar),
    isValidMobile: (mobile) => /^[0-9]{10}$/.test(mobile),
    isValidEmail: (email) => /^\S+@\S+\.\S+$/.test(email),
};

module.exports = {
    validate: async (data, user) => {
        const requiredFields = ['full_name', 'mobile_no', 'email_id', 'purpose', 'aadhar_no'];
        
        for (const field of requiredFields) {
            if (!data[field] || String(data[field]).trim() === '') {
                return `Field '${field}' is required and cannot be empty.`;
            }
        }

        if (!validators.isValidEmail(data.email_id)) {
            return 'Invalid email format provided.';
        }
        if (!validators.isValidMobile(data.mobile_no)) {
            return 'Mobile number must be a valid 10-digit number.';
        }
        if (!validators.isValidAadhar(data.aadhar_no)) {
            return 'Aadhar number must be a valid 12-digit number.';
        }

        const capturedFingers = data.fingerprints ? data.fingerprints.filter(f => f.data).length : 0;
        const missingFingers = data.missing_fingers ? data.missing_fingers.length : 0;
        if ((capturedFingers + missingFingers) < 6) {
            return 'A total of at least 6 fingerprints must be captured or marked as missing.';
        }
        
        return null;
    },

    process: async (data, user) => {
        const [websites] = await pool.query(
            "SELECT id, url, status, website_license_key FROM websites WHERE id = (SELECT website_id FROM users WHERE id = ?)",
            [user.id]
        );
        if (websites.length === 0 || websites[0].status !== 'approved') {
            throw new Error('User does not have an approved website for submissions.');
        }
        const website = websites[0];
        const headers = { 'X-Website-License': website.website_license_key };

        let servicePrice;
        let userBalance;
        try {
            const priceUrl = `${website.url}/api/service-price?service_key=mobile-email-update`;
            const priceResponse = await axios.get(priceUrl, { headers, timeout: 10000 });
            servicePrice = priceResponse.data.price;

            const walletUrl = `${website.url}/api/user/wallet?email=${encodeURIComponent(user.email)}`;
            const walletResponse = await axios.get(walletUrl, { headers, timeout: 10000 });
            userBalance = walletResponse.data.balance;

            if (servicePrice === undefined || userBalance === undefined) {
                throw new Error("Could not retrieve price or balance from the client website.");
            }
        } catch (error) {
            throw new Error('Could not verify price and balance with the client website.');
        }

        if (userBalance < servicePrice) {
            const error = new Error(`Insufficient wallet balance. Required: ${servicePrice}, Available: ${userBalance}`);
            error.statusCode = 402;
            throw error;
        }

        // Process data for PHP compatibility (no files for this form)
        const processedData = {
            email: sanitizeText(user.email),
            formData: {
                full_name: sanitizeText(data.full_name),
                mobile_no: sanitizeText(data.mobile_no),
                email_id: sanitizeText(data.email_id),
                purpose: sanitizeText(data.purpose),
                aadhar_no: sanitizeText(data.aadhar_no),
                father_name: sanitizeText(data.father_name || ''),
                fingerprint: data.fingerprints ? data.fingerprints.reduce((acc, fp) => {
                    if (fp && fp.id && fp.data) {
                        const cleanData = fp.data.replace(/^data:image\/[a-z]+;base64,/, '');
                        acc[sanitizeText(fp.id)] = cleanData;
                    }
                    return acc;
                }, {}) : {},
                missing_fingers: data.missing_fingers ? data.missing_fingers.map(f => sanitizeText(f)).join(',') : ''
            }
        };
        
        let finalResponseData;
        try {
            const submitUrl = `${website.url}/api/forms/mobile-email-update`;
            const response = await axios.post(submitUrl, processedData, { 
                headers, 
                timeout: 45000 
            });
            finalResponseData = response.data;
        } catch (error) {
            const errorMessage = error.response ? 
                (error.response.data.error || JSON.stringify(error.response.data)) : 
                'Failed to submit form to the client website.';
            throw new Error(errorMessage);
        }

        // --- NEW LOGGING FEATURE ---
        if (finalResponseData && finalResponseData.applicationId) {
            try {
                await pool.query(
                    'INSERT INTO submission_logs (user_id, website_id, form_type, application_id) VALUES (?, ?, ?, ?)',
                    [user.id, website.id, 'mobileEmailUpdate', finalResponseData.applicationId]
                );
                console.log(`[Logger] Successfully logged submission ${finalResponseData.applicationId} for user ${user.id}`);
            } catch (logError) {
                console.error('CRITICAL: Failed to log a successful submission!', logError);
            }
        }
        
        return finalResponseData; // Return the original success response to the app
    }
};
