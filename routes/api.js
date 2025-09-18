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

// --- Public Endpoint ---

// Serves the latest app info
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
        // The password now comes from the header for API-based uploads
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

router.post('/forms/:formType', authenticateToken, upload.any(), async (req, res) => {
    try {
        const { formType } = req.params;
        
        if (!/^[a-zA-Z0-9_]+$/.test(formType)) {
            return res.status(400).json({ error: 'Invalid form type specified.' });
        }

        const handlerPath = path.join(__dirname, '..', 'forms', `${formType}.js`);
        if (!fs.existsSync(handlerPath)) {
            return res.status(404).json({ error: `Form type '${formType}' not found.` });
        }

        // --- NEW FILE-TO-BASE64 CONVERSION LOGIC ---
        const formData = { ...req.body }; // Copy text fields
        if (req.files && req.files.length > 0) {
            for (const file of req.files) {
                // Convert the file's raw buffer into a Base64 string with the correct MIME type prefix
                const base64String = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
                // Add the Base64 string to our form data object.
                formData[`${file.fieldname}_base64`] = base64String;
            }
        }
        // --- END OF NEW LOGIC ---

        const formHandler = require(handlerPath);
        
        const validationError = await formHandler.validate(formData, req.user);
        if (validationError) {
             return res.status(400).json({ error: 'Validation failed', details: validationError });
        }

        const result = await formHandler.process(formData, req.user);
        res.json({ message: 'Form processed successfully.', data: result });

    } catch (error) {
        console.error(`Form submission error for ${req.params.formType}:`, error);
        if (error.statusCode === 402) {
            return res.status(402).json({ error: 'Payment Required', details: error.message });
        }
        res.status(500).json({ error: 'An error occurred while processing the form.' });
    }
});

module.exports = router;