const { pool } = require('../config/database');
const axios = require('axios');

const validators = {
    isFutureDate: (dateString) => new Date(dateString) > new Date(),
    isValidAadhar: (aadhar) => /^[0-9]{12}$/.test(aadhar),
    isValidPincode: (pincode) => /^[0-9]{6}$/.test(pincode),
};

module.exports = {
    validate: async (data, user) => {
        const requiredFields = [
            'old_name', 'new_name', 'father_name', 'dob', 'aadhaar_no',
            'purpose', 'pincode', 'village_town', 'district',
            'candidate_photo_base64', 'supporting_document_base64'
        ];
        
        for (const field of requiredFields) {
            if (!data[field] || String(data[field]).trim() === '') {
                return `Field '${field.replace('_base64', '')}' is required and cannot be empty.`;
            }
        }

        if (!validators.isValidAadhar(data.aadhaar_no)) {
            return 'Aadhaar number must be a valid 12-digit number.';
        }
        if (!validators.isValidPincode(data.pincode)) {
            return 'Pincode must be a valid 6-digit number.';
        }
        if (validators.isFutureDate(data.dob)) {
            return 'Date of birth cannot be in the future.';
        }
        if (data.old_name && data.new_name && 
            data.old_name.trim().toLowerCase() === data.new_name.trim().toLowerCase()) {
            return 'New name must be different from the old name.';
        }

        const capturedFingers = data.fingerprints ? data.fingerprints.filter(f => f.data).length : 0;
        const missingFingers = data.missing_fingers ? data.missing_fingers.length : 0;
        if ((capturedFingers + missingFingers) < 6) {
            return 'A total of at least 6 fingerprints must be captured or marked as missing.';
        }
        
        return null;
    },

    process: async (data, user) => {
        const [websites] = await pool.query("SELECT id, url, status, website_license_key FROM websites WHERE id = (SELECT website_id FROM users WHERE id = ?)", [user.id]);
        if (websites.length === 0 || websites[0].status !== 'approved') {
            throw new Error('User does not have an approved website for submissions.');
        }
        const website = websites[0];
        const headers = { 'X-Website-License': website.website_license_key };

        let servicePrice;
        let userBalance;
        try {
            const priceUrl = `${website.url}/api/service-price?service_key=name-update`;
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

        // Process data for PHP compatibility
        const processedData = {
            email: user.email,
            formData: {
                old_name: data.old_name,
                new_name: data.new_name,
                father_name: data.father_name,
                dob: data.dob,
                aadhaar_no: data.aadhaar_no,
                purpose: data.purpose,
                pincode: data.pincode,
                village_town: data.village_town,
                district: data.district,
                landmark: data.landmark || '',
                candidate_photo_base64: data.candidate_photo_base64,
                supporting_document_base64: data.supporting_document_base64,
                fingerprint: data.fingerprints ? data.fingerprints.reduce((acc, fp) => {
                    if (fp && fp.id && fp.data) {
                        const cleanData = fp.data.replace(/^data:image\/[a-z]+;base64,/, '');
                        acc[fp.id] = cleanData;
                    }
                    return acc;
                }, {}) : {},
                missing_fingers: data.missing_fingers ? data.missing_fingers.join(',') : ''
            }
        };
        
        let finalResponseData;
        try {
            const submitUrl = `${website.url}/api/forms/name-update`;
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
                    [user.id, website.id, 'nameUpdate', finalResponseData.applicationId]
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

