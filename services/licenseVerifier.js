const { pool } = require('../config/database');
const settingsService = require('./settingsService');
const dns = require('dns').promises; // Import dns for IP lookups
const url = require('url');       // Import url for parsing

let verificationInterval;

const verifier = {
    start: () => {
        console.log('Starting proactive license verifier...');

        const runVerificationCycle = async () => {
            console.log(`[${new Date().toISOString()}] Running scheduled verification cycle...`);
            
            const licenseService = require('./licenseService');

            // --- VERIFY USER LICENSES (WHMCS) ---
            try {
                // --- THE FIX: The query now joins with the websites table to get the URL ---
                const [usersToCheck] = await pool.query(
                    `SELECT u.id, u.license_key, u.license_status, w.url AS websiteUrl 
                     FROM users u
                     JOIN websites w ON u.website_id = w.id
                     WHERE u.license_status IN ('active', 'suspended', 'expired', 'reissued')`
                );

                if (usersToCheck.length > 0) {
                    console.log(`Verifying ${usersToCheck.length} user licenses...`);
                    for (const user of usersToCheck) {
                        if (!user.websiteUrl) continue; // Skip if user is not linked to a website

                        const parsedUrl = new url.URL(user.websiteUrl);
                        const hostname = parsedUrl.hostname;
                        
                        // --- THE FIX: Dynamically resolve the IP for each user's website ---
                        let resolvedIp = '';
                        try {
                            const { address } = await dns.lookup(hostname);
                            resolvedIp = address;
                        } catch (dnsError) {
                            console.warn(`Could not resolve IP for ${hostname} during scheduled check. Error: ${dnsError.message}`);
                            // Continue without the IP, the check might fail at WHMCS but won't crash the server.
                        }

                        // We now send the correct domain and its resolved IP, just like in the register route.
                        const result = await licenseService.checkUserLicense(user.license_key, { domain: hostname, ip: resolvedIp });
                        let newRemoteStatus = result.status.toLowerCase();

                        // Map WHMCS statuses to our database statuses
                        if (newRemoteStatus === 'reissued') {
                            newRemoteStatus = 'active';
                        }
                        if (newRemoteStatus === 'invalid') {
                            newRemoteStatus = 'suspended';
                        }

                        if (newRemoteStatus !== user.license_status) {
                            console.log(`User license status changing for user ${user.id}: ${user.license_status} -> ${newRemoteStatus}`);
                            await pool.query("UPDATE users SET license_status = ? WHERE id = ?", [newRemoteStatus, user.id]);
                        }
                    }
                }
            } catch (error) {
                console.error('Error during user license verification cycle:', error);
            }

            // --- VERIFY WEBSITE LICENSES (License Box) ---
            try {
                const [websitesToCheck] = await pool.query(
                    "SELECT id, url, status, website_license_key, client_name FROM websites WHERE status IN ('approved', 'suspended')"
                );

                if (websitesToCheck.length > 0) {
                    console.log(`Verifying ${websitesToCheck.length} website licenses...`);
                    for (const website of websitesToCheck) {
                        if (!website.website_license_key) continue;
                        
                        const result = await licenseService.checkWebsiteLicense(website.website_license_key, { 
                            websiteUrl: website.url, 
                            clientName: website.client_name 
                        });
                        
                        const newRemoteStatus = result.isValid ? 'approved' : 'suspended';

                        if (newRemoteStatus !== website.status) {
                             console.log(`Website license status changing for website ${website.id} (${website.url}): ${website.status} -> ${newRemoteStatus}`);
                             await pool.query("UPDATE websites SET status = ? WHERE id = ?", [newRemoteStatus, website.id]);
                        }
                    }
                }
            } catch (error) {
                console.error('Error during website license verification cycle:', error);
            }
            
            console.log('Scheduled verification cycle finished.');
        };

        runVerificationCycle();
        const intervalMs = parseInt(settingsService.get('LICENSE_CHECK_INTERVAL_MS'), 10) || 300000;
        verificationInterval = setInterval(runVerificationCycle, intervalMs);
    },

    stop: () => {
        clearInterval(verificationInterval);
    }
};

module.exports = verifier;