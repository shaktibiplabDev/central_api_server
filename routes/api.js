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

const upload = multer({
    storage: storage,
    limits: {
        fieldSize: 50 * 1024 * 1024, // allow up to 50MB per text field
        fields: 1000                 // allow many fields if needed
    }
});
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
            'document_base64': 'document'  // This should match what PHP expects
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
    isValidAadhar: (aadhar) => {
        if (!aadhar) return false;
        const cleanAadhar = aadhar.toString().replace(/\D/g, ''); // Remove non-digits
        return /^[0-9]{12}$/.test(cleanAadhar);
    },
    isValidMobile: (mobile) => {
        if (!mobile) return false;
        const cleanMobile = mobile.toString().replace(/\D/g, ''); // Remove non-digits
        return /^[0-9]{10}$/.test(cleanMobile);
    },
    isValidPincode: (pincode) => {
        if (!pincode) return false;
        const cleanPincode = pincode.toString().replace(/\D/g, ''); // Remove non-digits
        return /^[0-9]{6}$/.test(cleanPincode);
    },
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
        let fingerprintArray = [];

        // Handle array
        if (Array.isArray(fingerprints)) {
            fingerprintArray = fingerprints;
        }
        // Handle JSON string
        else if (typeof fingerprints === 'string') {
            try {
                fingerprintArray = JSON.parse(fingerprints);
            } catch (e) {
                console.error('Invalid fingerprints JSON:', e);
                return false;
            }
        }

        const capturedFingers = fingerprintArray.filter(f => f && f.data).length;
        const missingFingersCount = Array.isArray(missingFingers) ? missingFingers.length : 0;

        return (capturedFingers + missingFingersCount) >= 6;
    }
};

// --- Helper Functions ---
function processFingerprintData(formData) {
    // Look for fingerprint fields that might contain base64 data
    const fingerprintFields = Object.keys(formData).filter(key =>
        key.includes('fingerprint') &&
        !key.includes('_base64') && // Skip already processed
        typeof formData[key] === 'string' &&
        formData[key].startsWith('data:image/')
    );

    fingerprintFields.forEach(field => {
        formData[`${field}_base64`] = formData[field];
        console.log(`Processed fingerprint field: ${field}`);
    });
}

function cleanNumberFields(formData) {
    const numberFields = ['guardian_aadhar', 'guardian_mobile', 'pincode', 'aadhaar_no', 'aadhar_no', 'mobile_no'];

    numberFields.forEach(field => {
        if (formData[field]) {
            formData[field] = formData[field].toString().replace(/\D/g, '');
        }
    });
}

function handleFormError(error, res) {
    if (error.statusCode === 402) {
        return res.status(402).json({
            error: 'Payment Required',
            details: error.message,
            code: 'INSUFFICIENT_FUNDS'
        });
    }

    if (error.response) {
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

// --- FIXED Form Data Processor ---
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

    // FIXED: Process fingerprints - send as array directly to PHP
    if (formData.fingerprints && Array.isArray(formData.fingerprints)) {
        processedData.fields.fingerprints = formData.fingerprints.map(fp => ({
            id: fp.id,
            data: fp.data // Keep the full base64 string with data URI
        }));
    }

    // FIXED: Process missing fingers - send as array directly to PHP
    if (formData.missing_fingers && Array.isArray(formData.missing_fingers)) {
        processedData.fields.missing_fingers = formData.missing_fingers;
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

// --- FIXED FORM SUBMISSION ENDPOINT ---
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

        const fileName = formType.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
        const handlerPath = path.join(__dirname, '..', 'forms', `${fileName}.js`);

        if (!fs.existsSync(handlerPath)) {
            return res.status(404).json({ error: `Form handler for '${formType}' not found. Looking for: ${fileName}.js` });
        }

        // Process incoming data
        const formData = { ...req.body };

        console.log('=== RAW FORM DATA RECEIVED ===');
        console.log('Form type:', formType);
        console.log('Fields received:', Object.keys(formData));
        console.log('Fingerprints present:', !!formData.fingerprints);
        console.log('Missing fingers present:', !!formData.missing_fingers);

        // Handle file uploads (non-fingerprint documents)
        if (req.files && req.files.length > 0) {
            console.log('Files received:', req.files.length);
            for (const file of req.files) {
                try {
                    // Skip if this is a fingerprint file (handle separately)
                    if (file.fieldname.includes('fingerprint')) {
                        console.log('Skipping fingerprint file - already processed as base64');
                        fs.unlinkSync(file.path); // Clean up temp file
                        continue;
                    }

                    // Process regular documents
                    const fileData = fs.readFileSync(file.path);
                    const base64String = `data:${file.mimetype};base64,${fileData.toString('base64')}`;
                    formData[`${file.fieldname}_base64`] = base64String;
                    console.log(`Processed file: ${file.fieldname}`);

                    // Clean up the temporary file
                    fs.unlinkSync(file.path);
                } catch (fileError) {
                    console.error('Error processing file:', file.fieldname, fileError);
                    // Continue with other files even if one fails
                }
            }
        }

        // Parse JSON strings for fingerprints and missing_fingers
        if (formData.fingerprints && typeof formData.fingerprints === 'string') {
            try {
                formData.fingerprints = JSON.parse(formData.fingerprints);
                console.log('Parsed fingerprints from JSON string');
            } catch (e) {
                console.error('Invalid fingerprints JSON:', e);
                formData.fingerprints = [];
            }
        }

        if (formData.missing_fingers && typeof formData.missing_fingers === 'string') {
            try {
                formData.missing_fingers = JSON.parse(formData.missing_fingers);
                console.log('Parsed missing_fingers from JSON string');
            } catch (e) {
                console.error('Invalid missing_fingers JSON:', e);
                formData.missing_fingers = [];
            }
        }

        // Log fingerprint data for debugging
        if (formData.fingerprints) {
            console.log('Fingerprints count:', formData.fingerprints.length);
            console.log('Fingerprints data sample:', formData.fingerprints.slice(0, 1)); // Log first fingerprint only
        }

        if (formData.missing_fingers) {
            console.log('Missing fingers:', formData.missing_fingers);
        }

        // Clean number fields
        cleanNumberFields(formData);

        // Enhanced validation
        const validationErrors = validateFormData(formData, formType);
        if (validationErrors) {
            console.log('Validation errors:', validationErrors);
            return res.status(400).json({
                error: 'Validation failed',
                details: validationErrors,
                fieldMappings: fieldMappings[formType]
            });
        }

        console.log('=== CALLING FORM HANDLER ===');
        const formHandler = require(handlerPath);
        const result = await formHandler.process(formData, req.user);
        console.log('=== FORM HANDLER COMPLETED ===');

        res.json({
            message: 'Form processed successfully.',
            data: result,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error(`Form submission error for ${req.params.formType}:`, error);
        handleFormError(error, res);
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
        const user = req.user;

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
        const clientApiUrl = `${website.url}/api/prices`;

        const response = await axios.get(clientApiUrl, {
            headers: {
                'X-Website-License': website.website_license_key
            },
            timeout: 15000
        });

        // 4. Return the complete price list data with all fields and metadata
        const priceData = response.data || [];
        
        res.json({
            success: true,
            data: priceData,
            metadata: {
                total_services: priceData.length,
                active_services: priceData.filter(service => service.is_active).length,
                inactive_services: priceData.filter(service => !service.is_active).length,
                assignable_services: priceData.filter(service => service.is_assignable).length,
                timestamp: new Date().toISOString(),
                website_url: website.url
            }
        });

    } catch (error) {
        console.error(`Error fetching price list for user ${req.user.id}:`, error.message);
        
        if (error.response) {
            return res.status(error.response.status).json({ 
                success: false,
                error: 'An error occurred on the client website.', 
                details: error.response.data 
            });
        }
        
        if (error.code === 'ECONNABORTED') {
            return res.status(408).json({ 
                success: false,
                error: 'Request timeout - client website took too long to respond.' 
            });
        }
        
        res.status(500).json({ 
            success: false,
            error: 'Internal server error while fetching price list.' 
        });
    }
});

module.exports = router;