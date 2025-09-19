const axios = require('axios');
const crypto = require('crypto');
const dns = require('dns').promises; // Import the dns module for IP lookups
const url = require('url');       // Import the url module for parsing

/**
 * Verifies a USER license key against WHMCS.
 * @param {string} licenseKey The user license key to validate.
 * @param {object} [options={}] Optional data for the check.
 * @returns {Promise<{status: string, details: object}>}
 */
async function checkUserLicense(licenseKey, options = {}) {
    if (process.env.NODE_ENV !== 'production') {
        console.warn(`[DEV MODE] Mocking WHMCS check for user license: ${licenseKey}`);
        return { status: 'active', details: { message: 'Mock validation successful.', mock: true } };
    }
    
    try {
        // --- THE FIX: Dynamically resolve IP if domain is provided ---
        let resolvedIp = options.ip || '';
        
        if (options.domain) {
            try {
                const { address } = await dns.lookup(options.domain);
                resolvedIp = address;
            } catch (dnsError) {
                console.warn(`Could not resolve IP for ${options.domain}. Error: ${dnsError.message}`);
                // Continue without the IP, the check might fail at WHMCS but won't crash the server.
            }
        }

        const timestamp = Math.floor(Date.now() / 1000);
        const randomHash = crypto.createHash('md5').update(Math.random().toString() + licenseKey).digest('hex');
        const check_token = timestamp + randomHash;
        
        const postData = new URLSearchParams({
            licensekey: licenseKey,
            domain: options.domain || '',
            ip: resolvedIp, // Use the resolved IP
            dir: options.dir || '',
            check_token: check_token
        });
        
        const { data: responseBody } = await axios.post(process.env.WHMCS_API_URL, postData, { timeout: 20000 });
        
        const results = {};
        const matches = [...responseBody.matchAll(/<(.*?)>([^<]+)<\/\1>/g)];
        for (const match of matches) { results[match[1]] = match[2]; }
        
        if (results.md5hash) {
            const expectedHash = crypto.createHash('md5').update(process.env.WHMCS_SECRET_KEY + check_token).digest('hex');
            if (results.md5hash !== expectedHash) {
                results.status = 'Invalid';
                results.description = 'MD5 Checksum Verification Failed.';
            }
        } else {
            results.status = 'Invalid';
            results.description = 'MD5 Hash was missing.';
        }
        
        return { status: results.status ? results.status.toLowerCase() : 'invalid', details: results };
        
    } catch (error) {
        return { status: 'inactive', details: { message: 'Failed to contact WHMCS server.', error: error.message } };
    }
}

/**
 * Verifies a WEBSITE license key against the License Box API.
 * @param {string} licenseKey The website license key to validate.
 * @param {object} [options={}] Optional data for the check.
 * @returns {Promise<{isValid: boolean, message: string}>}
 */
async function checkWebsiteLicense(licenseKey, options = {}) {
    if (!process.env.LICENSE_BOX_API_URL || !process.env.LICENSE_BOX_API_KEY || !process.env.LICENSE_BOX_PRODUCT_ID) {
        console.error('License Box API URL, Key, or Product ID is not configured in .env');
        return { isValid: false, message: 'Server configuration error.' };
    }
    
    try {
        let resolvedIp = '127.0.0.1';
        try {
            if (options.websiteUrl) {
                const parsedUrl = new url.URL(options.websiteUrl);
                const { address } = await dns.lookup(parsedUrl.hostname);
                resolvedIp = address;
            }
        } catch (dnsError) {
            console.warn(`Could not resolve IP for ${options.websiteUrl}. Falling back to default. Error: ${dnsError.message}`);
        }

        const headers = {
            'LB-API-KEY': process.env.LICENSE_BOX_API_KEY,
            'LB-URL': options.websiteUrl,
            'LB-IP': resolvedIp,
            'LB-LANG': 'english',
            'Content-Type': 'application/json'
        };
        
        const body = {
            product_id: process.env.LICENSE_BOX_PRODUCT_ID,
            license_code: licenseKey,
            client_name: options.clientName || options.websiteUrl // Fallback to websiteUrl if clientName is missing
        };

        console.log('--- Sending Request to License Box API ---');
        console.log('URL:', process.env.LICENSE_BOX_API_URL);
        console.log('Headers:', headers);
        console.log('Body:', body);
        console.log('-------------------------------------------');
        
        const response = await axios.post(process.env.LICENSE_BOX_API_URL, body, { headers, timeout: 15000 });
        
        console.log('--- Received Response from License Box ---');
        console.log('Status:', response.status);
        console.log('Data:', response.data);
        console.log('----------------------------------------');

        if (response.data && (response.data.status === true || String(response.data.status).toLowerCase() === 'true')) {
            return { isValid: true, message: 'Website license is valid and active.' };
        } else {
            return { isValid: false, message: response.data.message || 'Website license is invalid or inactive.' };
        }
        
    } catch (error) {
        const errorMessage = error.response ? JSON.stringify(error.response.data) : 'Failed to contact the website license server.';
        console.error('--- License Box API Error ---');
        console.error(errorMessage);
        console.error('-----------------------------');
        return { isValid: false, message: errorMessage };
    }
}

module.exports = { 
    checkUserLicense,
    checkWebsiteLicense 
};