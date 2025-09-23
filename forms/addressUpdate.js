const { pool } = require('../config/database');
const axios = require('axios');

const validators = {
    isValidAadhar: (aadhar) => /^[0-9]{12}$/.test(aadhar),
    isValidMobile: (mobile) => /^[0-9]{10}$/.test(mobile),
    isValidPincode: (pincode) => /^[0-9]{6}$/.test(pincode),
};

module.exports = {
    validate: async (data, user) => {
        const requiredFields = [
            'full_name', 'aadhaar_no', 'village', 'district',
            'mobile_no', 'post', 'state', 'pincode', 'purpose',
            'document_base64'
        ];

        for (const field of requiredFields) {
            if (!data[field] || String(data[field]).trim() === '') {
                return `Field '${field.replace('_base64', '')}' is required and cannot be empty.`;
            }
        }

        if (!validators.isValidAadhar(data.aadhaar_no)) {
            return 'Aadhaar number must be a valid 12-digit number.';
        }
        if (!validators.isValidMobile(data.mobile_no)) {
            return 'Mobile number must be a valid 10-digit number.';
        }
        if (!validators.isValidPincode(data.pincode)) {
            return 'Pincode must be a valid 6-digit number.';
        }

        const capturedFingers = data.fingerprints ? data.fingerprints.filter(f => f.data).length : 0;
        const missingFingers = data.missing_fingers ? data.missing_fingers.length : 0;
        if ((capturedFingers + missingFingers) < 6) {
            return 'A total of at least 6 fingerprints must be captured or marked as missing.';
        }
        
        return null;
    },

    process: async (data, user) => {
        // Step 1: Get user's approved website details
        const [websites] = await pool.query("SELECT id, url, status, website_license_key FROM websites WHERE id = (SELECT website_id FROM users WHERE id = ?)", [user.id]);
        if (websites.length === 0 || websites[0].status !== 'approved') {
            throw new Error('User does not have an approved website for submissions.');
        }
        const website = websites[0];
        const headers = { 'X-Website-License': website.website_license_key };

        // Step 2: Pre-submission check for price and balance
        let servicePrice;
        let userBalance;
        try {
            const priceUrl = `${website.url}/api/service-price?service_key=address-update`;
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

        // Step 3: Check for sufficient funds
        if (userBalance < servicePrice) {
            const error = new Error(`Insufficient wallet balance. Required: ${servicePrice}, Available: ${userBalance}`);
            error.statusCode = 402;
            throw error;
        }

        // Process fingerprints for PHP compatibility
        const processedData = {
            email: user.email,
            formData: {
                // Map fields according to PHP form expectations
                full_name: data.full_name,
                aadhaar_no: data.aadhaar_no,
                village: data.village,
                district: data.district,
                mobile_no: data.mobile_no,
                post: data.post,
                state: data.state,
                pincode: data.pincode,
                purpose: data.purpose,
                landmark: data.landmark || '',
                document_base64: data.document_base64,
                // Process fingerprints for PHP format
                fingerprint: data.fingerprints ? data.fingerprints.reduce((acc, fp) => {
                    if (fp && fp.id && fp.data) {
                        // Remove base64 prefix for PHP compatibility
                        const cleanData = fp.data.replace(/^data:image\/[a-z]+;base64,/, '');
                        acc[fp.id] = cleanData;
                    }
                    return acc;
                }, {}) : {},
                missing_fingers: data.missing_fingers ? data.missing_fingers.join(',') : ''
            }
        };

        // Step 4: Submit to client website
        let finalResponseData;
        try {
            const submitUrl = `${website.url}/api/forms/address-update`;
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
        // After the client website confirms a successful submission, we save a record.
        if (finalResponseData && finalResponseData.applicationId) {
            try {
                await pool.query(
                    'INSERT INTO submission_logs (user_id, website_id, form_type, application_id) VALUES (?, ?, ?, ?)',
                    [user.id, website.id, 'addressUpdate', finalResponseData.applicationId]
                );
                console.log(`[Logger] Successfully logged submission ${finalResponseData.applicationId} for user ${user.id}`);
            } catch (logError) {
                // If logging fails, we don't want to fail the whole request for the user.
                // We just log this critical error to the console for you to review later.
                console.error('CRITICAL: Failed to log a successful submission!', logError);
            }
        }
        
        return finalResponseData; // Return the original success response to the app
    }
};

