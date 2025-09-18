const { pool } = require('../config/database');
const axios = require('axios'); // We use axios to orchestrate API calls

/**
 * A collection of validation helper functions.
 */
const validators = {
    isFutureDate: (dateString) => new Date(dateString) > new Date(),
    isValidAadhar: (aadhar) => /^[0-9]{12}$/.test(aadhar),
    isValidMobile: (mobile) => /^[0-9]{10}$/.test(mobile),
    isValidPincode: (pincode) => /^[0-9]{6}$/.test(pincode),
};

module.exports = {
    /**
     * Performs robust, multi-point validation on the incoming child enrollment data.
     */
    validate: async (data, user) => {
        // 1. Check for presence of all required fields
        const requiredFields = [
            'child_name', 'child_dob', 'child_gender', 'child_birthplace',
            'guardian_name', 'guardian_relation', 'guardian_aadhar', 'guardian_mobile',
            'address_line1', 'city', 'district', 'state', 'pincode',
            // Assume file data is sent as Base64 strings from the mobile app
            'birth_certificate_base64', 'guardian_id_proof_base64', 'child_photo_base64'
        ];
        for (const field of requiredFields) {
            if (!data[field] || String(data[field]).trim() === '') {
                return `Field '${field}' is required and cannot be empty.`;
            }
        }

        // 2. Perform specific format and logical validation
        if (validators.isFutureDate(data.child_dob)) {
            return 'Child date of birth cannot be in the future.';
        }
        if (!validators.isValidAadhar(data.guardian_aadhar)) {
            return 'Guardian Aadhar must be a valid 12-digit number.';
        }
        if (!validators.isValidMobile(data.guardian_mobile)) {
            return 'Guardian mobile must be a valid 10-digit number.';
        }
        if (!validators.isValidPincode(data.pincode)) {
            return 'Pincode must be a valid 6-digit number.';
        }
        if (data.guardian_email && !/^\S+@\S+\.\S+$/.test(data.guardian_email)) {
            return 'Guardian email is not a valid email format.';
        }

        // 3. Validate biometric data (fingerprints)
        // Assumes fingerprints are sent in an array like `fingerprints: [{id: 1, data: 'base64...'}, ...]`
        const capturedFingers = data.fingerprints ? data.fingerprints.filter(f => f.data).length : 0;
        const missingFingers = data.missing_fingers ? data.missing_fingers.length : 0;
        if ((capturedFingers + missingFingers) < 6) {
            return 'A total of at least 6 fingerprints must be captured or marked as missing.';
        }
        
        return null; // A null return means all validation passed
    },

    /**
     * Orchestrates the entire submission process, including the critical balance and price checks.
     */
    process: async (data, user) => {
        // --- STEP 1: Get the user's approved website details from our database ---
        const [websites] = await pool.query(
            "SELECT url, status, website_license_key FROM websites WHERE id = (SELECT website_id FROM users WHERE id = ?)",
            [user.id]
        );

        if (websites.length === 0 || websites[0].status !== 'approved') {
            throw new Error('User does not have an approved website for submissions.');
        }
        const website = websites[0];
        const headers = { 'X-Website-License': website.website_license_key };

        // --- STEP 2: Ask the client website for the price of this service and the user's current balance ---
        let servicePrice;
        let userBalance;
        try {
            const priceUrl = `${website.url}/api/service-price?service_key=child-enrollment`;
            const priceResponse = await axios.get(priceUrl, { headers, timeout: 10000 });
            servicePrice = priceResponse.data.price;

            const walletUrl = `${website.url}/api/user/wallet?email=${encodeURIComponent(user.email)}`;
            const walletResponse = await axios.get(walletUrl, { headers, timeout: 10000 });
            userBalance = walletResponse.data.balance;

            if (servicePrice === undefined || userBalance === undefined) {
                throw new Error("Could not retrieve price or balance from the client website.");
            }

        } catch (error) {
            console.error('Error fetching pre-submission data:', error.message);
            throw new Error('Could not verify price and balance with the client website.');
        }

        // --- STEP 3: Check if the user has sufficient funds ---
        if (userBalance < servicePrice) {
            const error = new Error(`Insufficient wallet balance. Required: ${servicePrice}, Available: ${userBalance}`);
            error.statusCode = 402; // Payment Required
            throw error;
        }

        // --- STEP 4: If funds are sufficient, send the full form data for final processing ---
        try {
            const submitUrl = `${website.url}/api/forms/child-enroll`;
            const finalResponse = await axios.post(submitUrl, {
                email: user.email,
                formData: data
            }, { headers, timeout: 45000 });

            return finalResponse.data;

        } catch (error) {
            console.error('Error during final form submission:', error.message);
            const errorMessage = error.response ? (error.response.data.error || JSON.stringify(error.response.data)) : 'Failed to submit form to the client website.';
            throw new Error(errorMessage);
        }
    }
};

