const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const url = require('url');

// Import local modules
const { pool } = require('../config/database');
const { checkUserLicense, checkWebsiteLicense } = require('../services/licenseService');
const { checkNameservers } = require('../services/dnsService');
const { sendNotification } = require('../bot/bot');
const settingsService = require('../services/settingsService');

const router = express.Router();

// --- Multer Configuration for File Uploads ---
const uploadDir = path.join(__dirname, '..', 'public/downloads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, `${Date.now()}-temp-${file.originalname}`)
});
const upload = multer({ storage: storage });
// --- End of Multer Config ---

// --- Field Mapping Configuration ---
const fieldMappings = {
    'child-enrollment': {
        fields: {
            'child_name': 'child_name',
            'child_dob': 'child_dob',
            'child_gender': 'child_gender',
            'child_birthplace': 'child_birthplace',
            'guardian_name': 'guardian_name',
            'guardian_relation': 'guardian_relation',
            'guardian_aadhar': 'guardian_aadhar',
            'guardian_mobile': 'guardian_mobile',
            'address_line1': 'address_line1',
            'city': 'city',
            'district': 'district',
            'state': 'state',
            'pincode': 'pincode',
            'purpose': 'purpose'
        },
        files: {
            'birth_certificate_base64': 'birth_certificate',
            'guardian_id_proof_base64': 'guardian_id_proof_file',
            'child_photo_base64': 'child_photo'
        }
    },
    'address-update': {
        fields: {
            'full_name': 'full_name',
            'aadhaar_no': 'aadhaar_no',
            'village': 'village',
            'district': 'district',
            'mobile_no': 'mobile_no',
            'post': 'post',
            'state': 'state',
            'pincode': 'pincode',
            'purpose': 'purpose',
            'landmark': 'landmark'
        },
        files: {
            'document_base64': 'document'
        }
    },
    'dob-update': {
        fields: {
            'full_name': 'full_name',
            'aadhaar_no': 'aadhaar_no',
            'village': 'village',
            'district': 'district',
            'mobile_no': 'mobile_no',
            'old_dob': 'old_dob',
            'post': 'post',
            'state': 'state',
            'new_dob': 'new_dob',
            'father_name': 'father_name',
            'pincode': 'pincode',
            'purpose': 'purpose',
            'landmark': 'landmark'
        },
        files: {
            'photo_base64': 'photo',
            'documents_base64': 'documents'
        }
    },
    'mobile-email-update': {
        fields: {
            'full_name': 'full_name',
            'mobile_no': 'mobile_no',
            'email_id': 'email_id',
            'purpose': 'purpose',
            'aadhar_no': 'aadhar_no',
            'father_name': 'father_name'
        },
        files: {} // No file uploads for this form
    },
    'name-update': {
        fields: {
            'old_name': 'old_name',
            'new_name': 'new_name',
            'father_name': 'father_name',
            'dob': 'dob',
            'aadhaar_no': 'aadhaar_no',
            'purpose': 'purpose',
            'pincode': 'pincode',
            'village_town': 'village_town',
            'district': 'district',
            'landmark': 'landmark'
        },
        files: {
            'candidate_photo_base64': 'candidate_photo',
            'supporting_document_base64': 'supporting_document'
        }
    }
};

// --- Enhanced Validators ---
const enhancedValidators = {
    isValidAadhar: (aadhar) => /^[0-9]{12}$/.test(aadhar),
    isValidMobile: (mobile) => /^[0-9]{10}$/.test(mobile),
    isValidPincode: (pincode) => /^[0-9]{6}$/.test(pincode),
    isValidEmail: (email) => /^\S+@\S+\.\S+$/.test(email),
    isFutureDate: (dateString) => new Date(dateString) > new Date(),
    areDatesSame: (date1, date2) => new Date(date1).toDateString() === new Date(date2).toDateString(),
    
    // File validation
    isValidBase64: (base64String) => {
        if (!base64String) return false;
        try {
            if (base64String.includes(';base64,')) {
                const parts = base64String.split(';base64,');
                if (parts.length !== 2) return false;
                return Buffer.from(parts[1], 'base64').length > 0;
            }
            return Buffer.from(base64String, 'base64').length > 0;
        } catch {
            return false;
        }
    },
    
    // Biometric validation
    validateFingerprints: (fingerprints, missingFingers) => {
        const capturedFingers = fingerprints ? fingerprints.filter(f => f && f.data).length : 0;
        const missingFingersCount = missingFingers ? missingFingers.length : 0;
        return (capturedFingers + missingFingersCount) >= 6;
    }
};

// --- Public Endpoint ---
router.get('/app-info', (req, res) => {
    try {
        const appInfo = {
            latestVersion: settingsService.get('APP_LATEST_VERSION') || '1.0.0',
            forceUpdateBelow: settingsService.get('APP_FORCE_UPDATE_BELOW') || '1.0.0',
            downloadUrl: settingsService.get('APP_DOWNLOAD_URL') || '#'
        };
        res.json(appInfo);
    } catch (error) {
        res.status(500).json({ error: 'Could not retrieve app information.' });
    }
});

// --- Reusable JWT Authentication Middleware ---
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Access token required' });
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid or expired token' });
        req.user = user;
        next();
    });
}

// --- Enhanced Form Data Processor ---
function processFormData(formData, formType) {
    const mapping = fieldMappings[formType];
    if (!mapping) {
        throw new Error(`No field mapping found for form type: ${formType}`);
    }

    const processedData = {
        fields: {},
        files: {}
    };

    // Process regular fields
    for (const [centralField, phpField] of Object.entries(mapping.fields)) {
        if (formData[centralField] !== undefined) {
            processedData.fields[phpField] = formData[centralField];
        }
    }

    // Process file fields
    for (const [centralField, phpField] of Object.entries(mapping.files)) {
        if (formData[centralField]) {
            processedData.files[phpField] = formData[centralField];
        }
    }

    // Process fingerprints - convert to PHP format
    if (formData.fingerprints && Array.isArray(formData.fingerprints)) {
        const phpFingerprints = {};
        formData.fingerprints.forEach(fp => {
            if (fp && fp.id && fp.data) {
                phpFingerprints[fp.id] = fp.data; // Remove base64 prefix for PHP compatibility
            }
        });
        processedData.fields.fingerprint = phpFingerprints;
    }

    // Process missing fingers
    if (formData.missing_fingers && Array.isArray(formData.missing_fingers)) {
        processedData.fields.missing_fingers = formData.missing_fingers.join(',');
    }

    return processedData;
}

// --- Enhanced Validation Function ---
function validateFormData(formData, formType) {
    const errors = [];

    // Required field validation based on form type
    const mapping = fieldMappings[formType];
    if (!mapping) {
        return [`Invalid form type: ${formType}`];
    }

    // Check required fields
    for (const [centralField, phpField] of Object.entries(mapping.fields)) {
        if (!formData[centralField] || String(formData[centralField]).trim() === '') {
            errors.push(`Field '${phpField}' is required.`);
        }
    }

    // Check required files
    for (const [centralField, phpField] of Object.entries(mapping.files)) {
        if (!formData[centralField]) {
            errors.push(`File '${phpField}' is required.`);
        }
    }

    // Form-specific validation
    switch (formType) {
        case 'child-enrollment':
            if (formData.child_dob && enhancedValidators.isFutureDate(formData.child_dob)) {
                errors.push('Child date of birth cannot be in the future.');
            }
            if (formData.guardian_aadhar && !enhancedValidators.isValidAadhar(formData.guardian_aadhar)) {
                errors.push('Guardian Aadhar must be a valid 12-digit number.');
            }
            if (formData.guardian_mobile && !enhancedValidators.isValidMobile(formData.guardian_mobile)) {
                errors.push('Guardian mobile must be a valid 10-digit number.');
            }
            if (formData.pincode && !enhancedValidators.isValidPincode(formData.pincode)) {
                errors.push('Pincode must be a valid 6-digit number.');
            }
            break;

        case 'address-update':
            if (formData.aadhaar_no && !enhancedValidators.isValidAadhar(formData.aadhaar_no)) {
                errors.push('Aadhaar number must be a valid 12-digit number.');
            }
            if (formData.mobile_no && !enhancedValidators.isValidMobile(formData.mobile_no)) {
                errors.push('Mobile number must be a valid 10-digit number.');
            }
            if (formData.pincode && !enhancedValidators.isValidPincode(formData.pincode)) {
                errors.push('Pincode must be a valid 6-digit number.');
            }
            break;

        case 'dob-update':
            if (formData.aadhaar_no && !enhancedValidators.isValidAadhar(formData.aadhaar_no)) {
                errors.push('Aadhaar number must be a valid 12-digit number.');
            }
            if (formData.mobile_no && !enhancedValidators.isValidMobile(formData.mobile_no)) {
                errors.push('Mobile number must be a valid 10-digit number.');
            }
            if (formData.pincode && !enhancedValidators.isValidPincode(formData.pincode)) {
                errors.push('Pincode must be a valid 6-digit number.');
            }
            if (formData.old_dob && enhancedValidators.isFutureDate(formData.old_dob)) {
                errors.push('Old date of birth cannot be in the future.');
            }
            if (formData.new_dob && enhancedValidators.isFutureDate(formData.new_dob)) {
                errors.push('New date of birth cannot be in the future.');
            }
            if (formData.old_dob && formData.new_dob && enhancedValidators.areDatesSame(formData.old_dob, formData.new_dob)) {
                errors.push('New DOB must be different from the old DOB.');
            }
            break;

        case 'mobile-email-update':
            if (formData.email_id && !enhancedValidators.isValidEmail(formData.email_id)) {
                errors.push('Invalid email format provided.');
            }
            if (formData.mobile_no && !enhancedValidators.isValidMobile(formData.mobile_no)) {
                errors.push('Mobile number must be a valid 10-digit number.');
            }
            if (formData.aadhar_no && !enhancedValidators.isValidAadhar(formData.aadhar_no)) {
                errors.push('Aadhar number must be a valid 12-digit number.');
            }
            break;

        case 'name-update':
            if (formData.aadhaar_no && !enhancedValidators.isValidAadhar(formData.aadhaar_no)) {
                errors.push('Aadhaar number must be a valid 12-digit number.');
            }
            if (formData.pincode && !enhancedValidators.isValidPincode(formData.pincode)) {
                errors.push('Pincode must be a valid 6-digit number.');
            }
            if (formData.dob && enhancedValidators.isFutureDate(formData.dob)) {
                errors.push('Date of birth cannot be in the future.');
            }
            if (formData.old_name && formData.new_name && 
                formData.old_name.trim().toLowerCase() === formData.new_name.trim().toLowerCase()) {
                errors.push('New name must be different from the old name.');
            }
            break;
    }

    // Biometric validation
    if (!enhancedValidators.validateFingerprints(formData.fingerprints, formData.missing_fingers)) {
        errors.push('A total of at least 6 fingerprints must be captured or marked as missing.');
    }

    // File validation
    for (const [centralField, phpField] of Object.entries(mapping.files)) {
        if (formData[centralField] && !enhancedValidators.isValidBase64(formData[centralField])) {
            errors.push(`Invalid file format for ${phpField}.`);
        }
    }

    return errors.length > 0 ? errors : null;
}

// --- Authentication Routes ---
router.post('/register', async (req, res) => {
    try {
        const { email, password, userLicenseKey, websiteUrl } = req.body;
        if (!email || !password || !userLicenseKey || !websiteUrl) return res.status(400).json({ error: 'All fields are required.' });

        const hostname = new url.URL(websiteUrl).hostname;
        const userLicenseResult = await checkUserLicense(userLicenseKey, { domain: hostname });
        if (userLicenseResult.status !== 'active') return res.status(400).json({ error: 'Your personal user license is not active.' });
        
        let websiteLicenseKey, clientName;
        try {
            const licenseResponse = await axios.get(`${websiteUrl}/api/verify-license`, { timeout: 10000 });
            websiteLicenseKey = licenseResponse.data.licenseKey;
            clientName = licenseResponse.data.clientName;
            if (!websiteLicenseKey || !clientName) throw new Error("Website did not return valid license details.");
            await axios.post(`${websiteUrl}/api/verify-credentials`, { email, password }, { timeout: 10000 });
        } catch (error) {
            if (error.config && error.config.url.includes('verify-credentials')) return res.status(401).json({ error: 'Invalid credentials for the specified website.' });
            return res.status(400).json({ error: 'Could not verify the provided website URL.' });
        }
        
        const licenseBoxResult = await checkWebsiteLicense(websiteLicenseKey, { websiteUrl, clientName });
        const nameserverResult = await checkNameservers(websiteUrl);

        let finalWebsiteStatus = 'pending';
        let approvalMessage = `Website \`${websiteUrl}\` is pending. Reason:`;
        if (licenseBoxResult.isValid && nameserverResult.isVerified) {
            finalWebsiteStatus = 'approved';
            approvalMessage = `Website \`${websiteUrl}\` was automatically approved.`;
        } else {
            if (!licenseBoxResult.isValid) approvalMessage += `\n- License Box: ${licenseBoxResult.message}`;
            if (!nameserverResult.isVerified) approvalMessage += `\n- Nameserver: ${nameserverResult.message}`;
        }
        
        let [websites] = await pool.query('SELECT id FROM websites WHERE url = ?', [websiteUrl]);
        let websiteId;
        if (websites.length > 0) {
            websiteId = websites[0].id;
            await pool.query("UPDATE websites SET status = ?, website_license_key = ?, client_name = ? WHERE id = ?", [finalWebsiteStatus, websiteLicenseKey, clientName, websiteId]);
        } else {
            const [newWebsite] = await pool.query("INSERT INTO websites (url, status, website_license_key, client_name) VALUES (?, ?, ?, ?)", [websiteUrl, finalWebsiteStatus, websiteLicenseKey, clientName]);
            websiteId = newWebsite.insertId;
        }
        const passwordHash = await bcrypt.hash(password, 12);
        const [userResult] = await pool.query('INSERT INTO users (email, password_hash, license_key, license_status, website_id) VALUES (?, ?, ?, ?, ?)', [email, passwordHash, userLicenseKey, 'active', websiteId]);

        await sendNotification(`🚀 **New User Registration**\n👤 Email: ${email}\n${approvalMessage}`, true);
        res.status(201).json({ message: 'Registration successful.', userId: userResult.insertId, websiteStatus: finalWebsiteStatus });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A user with this email or license key already exists.' });
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Internal server error during registration.' });
    }
});

router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
        const [users] = await pool.query(`SELECT u.id, u.email, u.password_hash, u.license_status, w.url AS websiteUrl FROM users u LEFT JOIN websites w ON u.website_id = w.id WHERE u.email = ?`, [email]);
        if (users.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
        const user = users[0];
        if (!user.websiteUrl) return res.status(500).json({ error: 'User is not associated with a website.' });
        try {
            await axios.post(`${user.websiteUrl}/api/verify-credentials`, { email, password }, { timeout: 10000 });
        } catch (error) {
            return res.status(401).json({ error: 'Invalid credentials provided for the website.' });
        }
        const isLocalPasswordValid = await bcrypt.compare(password, user.password_hash);
        if (!isLocalPasswordValid) {
            const newPasswordHash = await bcrypt.hash(password, 12);
            await pool.query("UPDATE users SET password_hash = ? WHERE id = ?", [newPasswordHash, user.id]);
        }
        if (user.license_status !== 'active') return res.status(403).json({ error: 'Account not active', details: `License status: ${user.license_status}` });
        const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '24h' });
        res.json({ message: 'Login successful', token });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Secure App Upload Endpoint (Postman/API method)
router.post('/app-upload', upload.single('apkfile'), async (req, res) => {
    try {
        const { token } = req.query;
        const password = req.header('X-Upload-Password');

        if (!token || !password || !req.file) {
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(400).json({ error: 'Token, password, and file are required.' });
        }
        const [uploads] = await pool.query("SELECT * FROM app_uploads WHERE token = ? AND status = 'pending'", [token]);
        if (uploads.length === 0) {
            fs.unlinkSync(req.file.path);
            return res.status(404).json({ error: 'Invalid or already used upload token.' });
        }
        const uploadSession = uploads[0];
        if (new Date() > new Date(uploadSession.expires_at)) {
            await pool.query("UPDATE app_uploads SET status = 'expired' WHERE id = ?", [uploadSession.id]);
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ error: 'Upload session has expired.' });
        }
        const isPasswordValid = await bcrypt.compare(password, uploadSession.password_hash);
        if (!isPasswordValid) {
            fs.unlinkSync(req.file.path);
            return res.status(401).json({ error: 'Invalid upload password.' });
        }
        const newFileName = `app-v${uploadSession.version}.apk`;
        const newFilePath = path.join(uploadDir, newFileName);
        fs.renameSync(req.file.path, newFilePath);
        
        const serverBaseUrl = process.env.SERVER_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
        const publicDownloadUrl = `${serverBaseUrl}/downloads/${newFileName}`;

        await settingsService.set('APP_LATEST_VERSION', uploadSession.version);
        await settingsService.set('APP_FORCE_UPDATE_BELOW', uploadSession.version);
        await settingsService.set('APP_DOWNLOAD_URL', publicDownloadUrl);
        await pool.query("UPDATE app_uploads SET status = 'completed' WHERE id = ?", [uploadSession.id]);

        await sendNotification(`✅ **New App Version Released: v${uploadSession.version}**\nDownload link has been updated.`, true);
        res.status(200).json({ message: `Successfully uploaded and released version ${uploadSession.version}` });
    } catch (error) {
        console.error('App upload error:', error);
        res.status(500).json({ error: 'An internal server error occurred during upload.' });
    }
});

// --- Protected Routes ---
router.get('/profile', authenticateToken, async (req, res) => {
    try {
        const [users] = await pool.query("SELECT id, email, license_key, license_status, created_at FROM users WHERE id = ?", [req.user.id]);
        if (users.length === 0) return res.status(404).json({ error: 'User not found' });
        const [websites] = await pool.query("SELECT id, url, status, created_at FROM websites WHERE id = (SELECT website_id FROM users WHERE id = ?)", [req.user.id]);
        res.json({ user: users[0], website: websites[0] || null });
    } catch (error) {
        console.error('Profile fetch error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get('/user/wallet', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const [websites] = await pool.query("SELECT url, status, website_license_key FROM websites WHERE id = (SELECT website_id FROM users WHERE id = ?)", [user.id]);
        if (websites.length === 0) return res.status(404).json({ error: "Associated website not found for this user." });
        const website = websites[0];
        if (website.status !== 'approved') return res.status(403).json({ error: `Cannot fetch data: Website is currently ${website.status}.` });
        const clientApiUrl = `${website.url}/api/user/wallet?email=${encodeURIComponent(user.email)}`;
        const response = await axios.get(clientApiUrl, { headers: { 'X-Website-License': website.website_license_key }, timeout: 15000 });
        res.json(response.data);
    } catch (error) {
        console.error(`Error fetching wallet for user ${req.user.id}:`, error.message);
        if (error.response) return res.status(error.response.status).json({ error: 'An error occurred on the client website.', details: error.response.data });
        res.status(500).json({ error: 'Internal server error while fetching wallet balance.' });
    }
});

// --- ENHANCED FORM SUBMISSION ENDPOINT ---
router.post('/forms/:formType', authenticateToken, upload.any(), async (req, res) => {
    try {
        const { formType } = req.params;
        
        if (!/^[a-zA-Z0-9-]+$/.test(formType)) {
            return res.status(400).json({ error: 'Invalid form type specified.' });
        }

        // Check if form type is supported
        if (!fieldMappings[formType]) {
            return res.status(404).json({ error: `Form type '${formType}' not supported.` });
        }

        const handlerPath = path.join(__dirname, '..', 'forms', `${formType}.js`);
        if (!fs.existsSync(handlerPath)) {
            return res.status(404).json({ error: `Form handler for '${formType}' not found.` });
        }

        // Process incoming data
        const formData = { ...req.body };
        
        // Handle file conversions - convert to Base64 strings
        if (req.files && req.files.length > 0) {
            for (const file of req.files) {
                const base64String = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
                formData[`${file.fieldname}_base64`] = base64String;
            }
        }

        const formHandler = require(handlerPath);
        
        // Enhanced validation
        const validationErrors = validateFormData(formData, formType);
        if (validationErrors) {
            return res.status(400).json({ 
                error: 'Validation failed', 
                details: validationErrors,
                fieldMappings: fieldMappings[formType]
            });
        }

        // Process the form with enhanced data
        const result = await formHandler.process(formData, req.user);
        
        res.json({ 
            message: 'Form processed successfully.', 
            data: result,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error(`Form submission error for ${req.params.formType}:`, error);
        
        // Enhanced error handling with specific messages
        if (error.statusCode === 402) {
            return res.status(402).json({ 
                error: 'Payment Required', 
                details: error.message,
                code: 'INSUFFICIENT_FUNDS'
            });
        }
        
        if (error.response) {
            // Pass through client website errors
            return res.status(error.response.status || 500).json({
                error: 'Client website error',
                details: error.response.data,
                code: 'CLIENT_WEBSITE_ERROR'
            });
        }
        
        res.status(500).json({ 
            error: 'An error occurred while processing the form.',
            details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error',
            code: 'INTERNAL_ERROR'
        });
    }
});

// --- THIS IS THE NEW HISTORY ENDPOINT ---
router.get('/forms/history', authenticateToken, async (req, res) => {
    try {
        const user = req.user;

        // Securely fetches data directly from our own central database
        const [history] = await pool.query(
            `SELECT form_type, application_id, status, submitted_at 
             FROM submission_logs 
             WHERE user_id = ? 
             ORDER BY submitted_at DESC 
             LIMIT 50`,
            [user.id]
        );

        res.json(history);

    } catch (error) {
        console.error(`Error fetching form history for user ${req.user.id}:`, error.message);
        res.status(500).json({ error: 'Internal server error while fetching form history.' });
    }
});

// --- NEW ENDPOINT: Get a website's full price list for display in the app ---
router.get('/services/pricelist', authenticateToken, async (req, res) => {
    try {
        const user = req.user; // User object from JWT

        // 1. Get the user's website details from our database
        const [websites] = await pool.query(
            "SELECT url, status, website_license_key FROM websites WHERE id = (SELECT website_id FROM users WHERE id = ?)",
            [user.id]
        );

        if (websites.length === 0) {
            return res.status(404).json({ error: "Associated website not found for this user." });
        }
        
        const website = websites[0];

        // 2. Check if the website is approved
        if (website.status !== 'approved') {
            return res.status(403).json({ error: `Cannot fetch data: Website is currently ${website.status}.` });
        }

        // 3. Proxy the request to the client website to get their full price list
        const clientApiUrl = `${website.url}/api/prices/full-list`;

        const response = await axios.get(clientApiUrl, {
            headers: {
                // The secret key proves this request is from our trusted server
                'X-Website-License': website.website_license_key
            },
            timeout: 15000
        });

        // 4. Relay the price list back to the mobile app
        res.json(response.data);

    } catch (error) {
        console.error(`Error fetching price list for user ${req.user.id}:`, error.message);
        if (error.response) {
            return res.status(error.response.status).json({ error: 'An error occurred on the client website.', details: error.response.data });
        }
        res.status(500).json({ error: 'Internal server error while fetching price list.' });
    }
});

module.exports = router;