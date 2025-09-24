const { pool } = require('../config/database');
const settingsService = require('./settingsService');
const dns = require('dns').promises;
const url = require('url');
const axios = require('axios'); // We need axios for the price list call

const verifier = {
    /**
     * This function is now the main background worker task.
     * It runs the full verification and synchronization cycle.
     */
    async runVerificationCycle() {
        console.log(`[WORKER] Running verification cycle...`);
        const licenseService = require('./licenseService');

        // --- Block 1: Verify User Licenses (WHMCS) ---
        try {
            const [usersToCheck] = await pool.query(
                `SELECT u.id, u.license_key, u.license_status, w.url AS websiteUrl 
                 FROM users u
                 LEFT JOIN websites w ON u.website_id = w.id
                 WHERE u.license_status IN ('active', 'suspended', 'expired', 'reissued', 'inactive', 'invalid')`
            );

            if (usersToCheck.length > 0) {
                console.log(`[WORKER] Verifying ${usersToCheck.length} user licenses...`);
                for (const user of usersToCheck) {
                    if (!user.websiteUrl) continue;
                    const hostname = new url.URL(user.websiteUrl).hostname;
                    let resolvedIp = '';
                    try {
                        const { address } = await dns.lookup(hostname);
                        resolvedIp = address;
                    } catch (dnsError) {
                        console.warn(`[WORKER] Could not resolve IP for ${hostname} during check.`);
                    }
                    const result = await licenseService.checkUserLicense(user.license_key, { domain: hostname, ip: resolvedIp });
                    let newRemoteStatus = result.status.toLowerCase();
                    if (newRemoteStatus === 'reissued') newRemoteStatus = 'active';
                    if (newRemoteStatus !== user.license_status) {
                        console.log(`[WORKER] User license status changing for user ${user.id}: ${user.license_status} -> ${newRemoteStatus}`);
                        await pool.query("UPDATE users SET license_status = ? WHERE id = ?", [newRemoteStatus, user.id]);
                    }
                }
            }
        } catch (error) {
            console.error('[WORKER] Error during user license verification cycle:', error);
        }

        // --- Block 2: Verify Website Licenses (License Box) ---
        try {
            const [websitesToCheck] = await pool.query(
                "SELECT id, url, status, website_license_key, client_name FROM websites WHERE status IN ('approved', 'suspended')"
            );
            if (websitesToCheck.length > 0) {
                console.log(`[WORKER] Verifying ${websitesToCheck.length} website licenses...`);
                for (const website of websitesToCheck) {
                    if (!website.website_license_key) continue;
                    const result = await licenseService.checkWebsiteLicense(website.website_license_key, { websiteUrl: website.url, clientName: website.client_name });
                    const newRemoteStatus = result.isValid ? 'approved' : 'suspended';
                    if (newRemoteStatus !== website.status) {
                         console.log(`[WORKER] Website license status changing for website ${website.id}: ${website.status} -> ${newRemoteStatus}`);
                         await pool.query("UPDATE websites SET status = ? WHERE id = ?", [newRemoteStatus, website.id]);
                    }
                }
            }
        } catch (error) {
            console.error('[WORKER] Error during website license verification cycle:', error);
        }
        
        // --- NEW Block 3: Synchronize Website Price Lists ---
        try {
            const [approvedWebsites] = await pool.query("SELECT id, url, website_license_key FROM websites WHERE status = 'approved'");
            if (approvedWebsites.length > 0) {
                console.log(`[WORKER] Synchronizing price lists for ${approvedWebsites.length} websites...`);
                for (const website of approvedWebsites) {
                    try {
                        const pricesUrl = `${website.url}/api/prices/full-list`;
                        const headers = { 'X-Website-License': website.website_license_key };
                        const response = await axios.get(pricesUrl, { headers, timeout: 15000 });
                        
                        if (response.data && Array.isArray(response.data)) {
                            // Use an efficient "UPSERT" query to update or insert prices into our cache table
                            for (const item of response.data) {
                                if (item.service_key && item.price) {
                                    await pool.query(
                                        `INSERT INTO website_prices (website_id, service_key, price)
                                         VALUES (?, ?, ?)
                                         ON DUPLICATE KEY UPDATE price = VALUES(price)`,
                                        [website.id, item.service_key, item.price]
                                    );
                                }
                            }
                        }
                    } catch (priceError) {
                        console.error(`[WORKER] Failed to sync prices for website ID ${website.id}: ${priceError.message}`);
                    }
                }
            }
        } catch (error) {
            console.error('[WORKER] Error during price list synchronization:', error);
        }
        
        console.log('[WORKER] Verification cycle finished.');
    }
};

module.exports = verifier;

