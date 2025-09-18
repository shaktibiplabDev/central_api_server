const { pool } = require('../config/database');
const axios = require('axios');

/**
 * A collection of validation helper functions.
 */
const validators = {
    isFutureDate: (dateString) => new Date(dateString) > new Date(),
    isValidAadhar: (aadhar) => /^[0-9]{12}$/.test(aadhar),
    isValidPincode: (pincode) => /^[0-9]{6}$/.test(pincode),
};

module.exports = {
    /**
     * Performs robust validation on the incoming name update data.
     */
    validate: async (data, user) => {
        const requiredFields = [
            'old_name', 'new_name', 'father_name', 'dob', 'aadhaar_no',
            'purpose', 'pincode', 'village_town', 'district',
            'candidate_photo_base64', 'supporting_document_base64'
        ];
        for (const field of requiredFields) {
            if (!data[field] || String(data[field]).trim() === '') {
                return `Field '${field}' is required and cannot be empty.`;
            }
        }

        // --- Format & Logic Validation ---
        if (!validators.isValidAadhar(data.aadhaar_no)) return 'Aadhaar number must be a valid 12-digit number.';
        if (!validators.isValidPincode(data.pincode)) return 'Pincode must be a valid 6-digit number.';
        if (validators.isFutureDate(data.dob)) return 'Date of birth cannot be in the future.';
        if (data.old_name.trim().toLowerCase() === data.new_name.trim().toLowerCase()) return 'New name must be different from the old name.';


        // --- Biometric Validation ---
        const capturedFingers = data.fingerprints ? data.fingerprints.filter(f => f.data).length : 0;
        const missingFingers = data.missing_fingers ? data.missing_fingers.length : 0;
        if ((capturedFingers + missingFingers) < 6) {
            return 'A total of at least 6 fingerprints must be captured or marked as missing.';
        }
        
        return null; // All validation passed
    },

    /**
     * Orchestrates the secure submission of the name update form.
     */
    process: async (data, user) => {
        // Step 1: Get user's approved website details
        const [websites] = await pool.query("SELECT url, status, website_license_key FROM websites WHERE id = (SELECT website_id FROM users WHERE id = ?)", [user.id]);
        if (websites.length === 0 || websites[0].status !== 'approved') {
            throw new Error('User does not have an approved website for submissions.');
        }
        const website = websites[0];
        const headers = { 'X-Website-License': website.website_license_key };

        // Step 2: Pre-submission check for price and balance
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

        // Step 3: Check for sufficient funds
        if (userBalance < servicePrice) {
            const error = new Error(`Insufficient wallet balance. Required: ${servicePrice}, Available: ${userBalance}`);
            error.statusCode = 402; // Payment Required
            throw error;
        }

        // Step 4: Submit the full form data for final processing
        try {
            const submitUrl = `${website.url}/api/forms/name-update`;
            const finalResponse = await axios.post(submitUrl, {
                email: user.email,
                formData: data
            }, { headers, timeout: 45000 });

            return finalResponse.data;
        } catch (error) {
            const errorMessage = error.response ? (error.response.data.error || JSON.stringify(error.response.data)) : 'Failed to submit form to the client website.';
            throw new Error(errorMessage);
        }
    }
};
