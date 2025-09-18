const { pool } = require('../config/database');
const axios = require('axios');

/**
 * A collection of validation helper functions.
 */
const validators = {
    isValidAadhar: (aadhar) => /^[0-9]{12}$/.test(aadhar),
    isValidMobile: (mobile) => /^[0-9]{10}$/.test(mobile),
    isValidEmail: (email) => /^\S+@\S+\.\S+$/.test(email),
};

module.exports = {
    /**
     * Performs robust validation on the incoming mobile/email update data.
     */
    validate: async (data, user) => {
        const requiredFields = ['full_name', 'mobile_no', 'email_id', 'purpose', 'aadhar_no'];
        for (const field of requiredFields) {
            if (!data[field] || String(data[field]).trim() === '') {
                return `Field '${field}' is required and cannot be empty.`;
            }
        }

        // --- Format Validation ---
        if (!validators.isValidEmail(data.email_id)) {
            return 'Invalid email format provided.';
        }
        if (!validators.isValidMobile(data.mobile_no)) {
            return 'Mobile number must be a valid 10-digit number.';
        }
        if (!validators.isValidAadhar(data.aadhar_no)) {
            return 'Aadhar number must be a valid 12-digit number.';
        }

        // --- Biometric Validation ---
        const capturedFingers = data.fingerprints ? data.fingerprints.filter(f => f.data).length : 0;
        const missingFingers = data.missing_fingers ? data.missing_fingers.length : 0;
        if ((capturedFingers + missingFingers) < 6) {
            return 'A total of at least 6 fingerprints must be captured or marked as missing.';
        }
        
        return null; // All validation passed
    },

    /**
     * Orchestrates the secure submission of the mobile/email update form.
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

        // Step 3: Check for sufficient funds
        if (userBalance < servicePrice) {
            const error = new Error(`Insufficient wallet balance. Required: ${servicePrice}, Available: ${userBalance}`);
            error.statusCode = 402; // Payment Required
            throw error;
        }

        // Step 4: Submit the full form data for final processing
        try {
            const submitUrl = `${website.url}/api/forms/mobile-email-update`;
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
