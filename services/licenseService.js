const axios = require('axios');
const crypto = require('crypto');
const dns = require('dns').promises;
const url = require('url');

class LicenseService {
    constructor() {
        this.whmcsApiUrl = process.env.WHMCS_API_URL;
        this.whmcsSecretKey = process.env.WHMCS_SECRET_KEY;
        this.licenseBoxApiUrl = process.env.LICENSE_BOX_API_URL;
        this.licenseBoxApiKey = process.env.LICENSE_BOX_API_KEY;
        this.licenseBoxProductId = process.env.LICENSE_BOX_PRODUCT_ID;
        
        this.validateConfig();
    }

    validateConfig() {
        const requiredEnvVars = [
            'WHMCS_API_URL',
            'WHMCS_SECRET_KEY',
            'LICENSE_BOX_API_URL', 
            'LICENSE_BOX_API_KEY',
            'LICENSE_BOX_PRODUCT_ID'
        ];

        const missing = requiredEnvVars.filter(envVar => !process.env[envVar]);
        if (missing.length > 0) {
            throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
        }
    }

    /**
     * Verifies a USER license key against WHMCS.
     * @param {string} licenseKey The user license key to validate.
     * @param {object} [options={}] Optional data for the check.
     * @returns {Promise<{status: string, details: object}>}
     */
    async checkUserLicense(licenseKey, options = {}) {
        // Input validation
        if (!licenseKey || typeof licenseKey !== 'string') {
            throw new Error('License key is required and must be a string');
        }

        // Development mode check
        if (process.env.NODE_ENV !== 'production') {
            this.log('warn', `Mocking WHMCS check for user license: ${licenseKey}`);
            return { 
                status: 'active', 
                details: { 
                    message: 'Mock validation successful.', 
                    mock: true 
                } 
            };
        }
        
        try {
            const resolvedIp = await this.resolveDomainIp(options.domain, options.ip);
            const { check_token, timestamp } = this.generateCheckToken(licenseKey);
            
            const postData = new URLSearchParams({
                licensekey: licenseKey,
                domain: options.domain || '',
                ip: resolvedIp,
                dir: options.dir || '',
                check_token: check_token
            });
            
            this.log('info', 'Sending request to WHMCS API', {
                licenseKey: this.maskLicenseKey(licenseKey),
                domain: options.domain,
                ip: resolvedIp
            });
            
            const { data: responseBody } = await axios.post(
                this.whmcsApiUrl, 
                postData, 
                { 
                    timeout: parseInt(process.env.WHMCS_TIMEOUT) || 20000,
                    headers: {
                        'User-Agent': 'LicenseService/1.0'
                    }
                }
            );
            
            this.log('debug', 'Received WHMCS response', { responseBody });

            const results = this.parseWhmcsResponse(responseBody);
            const status = this.determineLicenseStatus(results);
            
            // Verify MD5 hash if present
            await this.verifyMd5Hash(results, check_token);
            
            this.log('info', 'License check completed', {
                licenseKey: this.maskLicenseKey(licenseKey),
                status,
                domain: options.domain
            });
            
            return { 
                status, 
                details: results 
            };
            
        } catch (error) {
            this.log('error', 'WHMCS API error', {
                error: error.message,
                licenseKey: this.maskLicenseKey(licenseKey),
                domain: options.domain
            });
            
            return { 
                status: 'inactive', 
                details: { 
                    message: 'Failed to contact WHMCS server.', 
                    error: error.message 
                } 
            };
        }
    }

    /**
     * Verifies a WEBSITE license key against the License Box API.
     * @param {string} licenseKey The website license key to validate.
     * @param {object} [options={}] Optional data for the check.
     * @returns {Promise<{isValid: boolean, message: string}>}
     */
    async checkWebsiteLicense(licenseKey, options = {}) {
        // Input validation
        if (!licenseKey || typeof licenseKey !== 'string') {
            throw new Error('License key is required and must be a string');
        }

        if (!this.licenseBoxApiUrl || !this.licenseBoxApiKey || !this.licenseBoxProductId) {
            this.log('error', 'License Box configuration missing');
            return { 
                isValid: false, 
                message: 'Server configuration error.' 
            };
        }
        
        try {
            const resolvedIp = await this.resolveDomainIp(options.websiteUrl, '127.0.0.1');
            
            const headers = {
                'LB-API-KEY': this.licenseBoxApiKey,
                'LB-URL': options.websiteUrl || '',
                'LB-IP': resolvedIp,
                'LB-LANG': 'english',
                'Content-Type': 'application/json',
                'User-Agent': 'LicenseService/1.0'
            };
            
            const body = {
                product_id: this.licenseBoxProductId,
                license_code: licenseKey,
                client_name: options.clientName || options.websiteUrl || ''
            };

            this.log('info', 'Sending request to License Box API', {
                licenseKey: this.maskLicenseKey(licenseKey),
                websiteUrl: options.websiteUrl
            });
            
            const response = await axios.post(
                this.licenseBoxApiUrl, 
                body, 
                { 
                    headers, 
                    timeout: parseInt(process.env.LICENSE_BOX_TIMEOUT) || 15000 
                }
            );
            
            this.log('debug', 'Received License Box response', {
                status: response.status,
                data: response.data
            });

            const isValid = this.isLicenseBoxResponseValid(response.data);
            const message = isValid 
                ? 'Website license is valid and active.'
                : response.data?.message || 'Website license is invalid or inactive.';

            this.log('info', 'License Box check completed', {
                licenseKey: this.maskLicenseKey(licenseKey),
                isValid,
                websiteUrl: options.websiteUrl
            });

            return { isValid, message };
            
        } catch (error) {
            const errorMessage = error.response 
                ? `License Box API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`
                : `Failed to contact License Box server: ${error.message}`;
            
            this.log('error', 'License Box API error', {
                error: errorMessage,
                licenseKey: this.maskLicenseKey(licenseKey),
                websiteUrl: options.websiteUrl
            });
            
            return { 
                isValid: false, 
                message: errorMessage 
            };
        }
    }

    // Helper methods
    async resolveDomainIp(domain, fallbackIp = '') {
        if (!domain) return fallbackIp;

        try {
            const parsedUrl = new url.URL(domain);
            const { address } = await dns.lookup(parsedUrl.hostname);
            return address;
        } catch (dnsError) {
            this.log('warn', `Could not resolve IP for domain: ${domain}`, { error: dnsError.message });
            return fallbackIp;
        }
    }

    generateCheckToken(licenseKey) {
        const timestamp = Math.floor(Date.now() / 1000);
        const randomHash = crypto.createHash('md5')
            .update(Math.random().toString() + licenseKey + timestamp)
            .digest('hex');
        const check_token = timestamp + randomHash;
        
        return { check_token, timestamp };
    }

    parseWhmcsResponse(responseBody) {
        const results = {};
        try {
            const matches = [...responseBody.matchAll(/<(.*?)>([^<]+)<\/\1>/g)];
            for (const match of matches) { 
                results[match[1]] = match[2]; 
            }
        } catch (error) {
            this.log('error', 'Failed to parse WHMCS response', { error: error.message });
        }
        return results;
    }

    determineLicenseStatus(results) {
        if (!results.status) {
            this.log('warn', 'WHMCS did not return a status field');
            return 'invalid';
        }

        const whmcsStatus = results.status.toLowerCase().trim();
        this.log('debug', 'WHMCS status mapping', { 
            rawStatus: results.status, 
            normalizedStatus: whmcsStatus 
        });

        const statusMap = {
            'active': 'active',
            'reissued': 'active',
            'suspended': 'suspended', 
            'expired': 'expired'
        };

        return statusMap[whmcsStatus] || 'invalid';
    }

    async verifyMd5Hash(results, check_token) {
        if (!results.md5hash) {
            this.log('warn', 'WHMCS MD5 hash missing from response');
            results.description = 'MD5 Hash was missing.';
            return false;
        }

        const expectedHash = crypto.createHash('md5')
            .update(this.whmcsSecretKey + check_token)
            .digest('hex');

        if (results.md5hash !== expectedHash) {
            this.log('error', 'WHMCS MD5 checksum verification failed');
            results.description = 'MD5 Checksum Verification Failed.';
            return false;
        }

        this.log('debug', 'WHMCS MD5 checksum verification passed');
        return true;
    }

    isLicenseBoxResponseValid(responseData) {
        if (!responseData) return false;
        
        if (responseData.status === true) return true;
        if (String(responseData.status).toLowerCase() === 'true') return true;
        
        return false;
    }

    maskLicenseKey(licenseKey) {
        if (!licenseKey || licenseKey.length < 8) return '***';
        return licenseKey.substring(0, 4) + '***' + licenseKey.substring(licenseKey.length - 4);
    }

    log(level, message, meta = {}) {
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            level: level.toUpperCase(),
            service: 'LicenseService',
            message,
            ...meta
        };

        if (level === 'error') {
            console.error(JSON.stringify(logEntry));
        } else if (level === 'warn') {
            console.warn(JSON.stringify(logEntry));
        } else if (process.env.NODE_ENV === 'production' && level === 'debug') {
            // Skip debug logs in production unless explicitly enabled
            if (process.env.ENABLE_DEBUG_LOGS === 'true') {
                console.log(JSON.stringify(logEntry));
            }
        } else {
            console.log(JSON.stringify(logEntry));
        }
    }
}

// Create singleton instance
const licenseService = new LicenseService();

module.exports = licenseService;