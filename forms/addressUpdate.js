const { pool } = require('../config/database');
const axios = require('axios');

// --- Validators ---
const validators = {
    isValidAadhar: (aadhar) => /^[0-9]{12}$/.test(aadhaarSanitize(aadhar)),
    isValidMobile: (mobile) => /^[0-9]{10}$/.test(mobileSanitize(mobile)),
    isValidPincode: (pincode) => /^[0-9]{6}$/.test(pincodeSanitize(pincode)),
};

// --- Sanitization functions ---
const textSanitize = (text, maxLength) => {
    if (!text) return '';
    return text.toString().trim().slice(0, maxLength);
};

const aadhaarSanitize = (aadhaar) => {
    if (!aadhaar) return '';
    return aadhaar.toString().replace(/\D/g, '').slice(0, 12);
};

const mobileSanitize = (mobile) => {
    if (!mobile) return '';
    return mobile.toString().replace(/\D/g, '').slice(0, 10);
};

const pincodeSanitize = (pincode) => {
    if (!pincode) return '';
    return pincode.toString().replace(/\D/g, '').slice(0, 6);
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

        if (userBalance < servicePrice) {
            const error = new Error(`Insufficient wallet balance. Required: ${servicePrice}, Available: ${userBalance}`);
            error.statusCode = 402;
            throw error;
        }

        // FIXED: Send fingerprints as array and missing_fingers as array
        const processedData = {
            email: user.email,
            formData: {
                full_name: textSanitize(data.full_name, 100),
                aadhaar_no: aadhaarSanitize(data.aadhaar_no),
                village: textSanitize(data.village, 100),
                district: textSanitize(data.district, 50),
                mobile_no: mobileSanitize(data.mobile_no),
                post: textSanitize(data.post, 50),
                state: textSanitize(data.state, 50),
                pincode: pincodeSanitize(data.pincode),
                purpose: textSanitize(data.purpose, 100),
                landmark: textSanitize(data.landmark, 100),
                document_base64: data.document_base64,
                // FIXED: Send as array, not object
                fingerprints: data.fingerprints ? data.fingerprints.map(fp => ({
                    id: fp.id,
                    data: fp.data // Keep full base64 string
                })) : [],
                // FIXED: Send as array
                missing_fingers: data.missing_fingers || []
            }
        };

        let finalResponseData;
        try {
            const submitUrl = `${website.url}/api/forms/address-update`;
            const response = await axios.post(submitUrl, processedData, { headers, timeout: 45000 });
            finalResponseData = response.data;
        } catch (error) {
            const errorMessage = error.response ? 
                (error.response.data.error || JSON.stringify(error.response.data)) : 
                'Failed to submit form to the client website.';
            throw new Error(errorMessage);
        }

        if (finalResponseData && finalResponseData.applicationId) {
            try {
                await pool.query(
                    'INSERT INTO submission_logs (user_id, website_id, form_type, application_id) VALUES (?, ?, ?, ?)',
                    [user.id, website.id, 'addressUpdate', finalResponseData.applicationId]
                );
                console.log(`[Logger] Successfully logged submission ${finalResponseData.applicationId} for user ${user.id}`);
            } catch (logError) {
                console.error('CRITICAL: Failed to log a successful submission!', logError);
            }
        }

        return finalResponseData;
    }
};