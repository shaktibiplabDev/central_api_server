// jobs/licenseVerifier.js
const { pool } = require('../config/database');
const dns = require('dns').promises;
const url = require('url');
const cron = require('node-cron');

class LicenseVerifier {
    constructor() {
        this.cronJob = null;
        this.isRunning = false;
        this.licenseService = require('./licenseService');
        this.batchSize = parseInt(process.env.LICENSE_BATCH_SIZE) || 50;
        this.useInternal = (process.env.USE_INTERNAL_LICENSE === 'true');

        this.validateDatabasePool();
    }

    validateDatabasePool() {
        if (!pool) {
            throw new Error('Database pool is not initialized');
        }
    }

    /**
     * Start the automatic license verification scheduler
     */
    startScheduler() {
        const schedule = process.env.LICENSE_CHECK_CRON || '*/15 * * * *';
        
        if (!cron.validate(schedule)) {
            throw new Error(`Invalid cron schedule: ${schedule}`);
        }

        this.log('info', 'Starting license verification scheduler', { schedule, useInternal: this.useInternal });
        
        // Run immediately on startup with delay to allow app to fully initialize
        setTimeout(() => {
            this.runVerificationCycle().catch(error => {
                this.log('error', 'Initial verification cycle failed', { error: error.message });
            });
        }, 30000); // 30 second delay
        
        // Then run on schedule
        this.cronJob = cron.schedule(schedule, () => {
            this.log('info', 'Running scheduled license verification');
            this.runVerificationCycle().catch(error => {
                this.log('error', 'Scheduled verification cycle failed', { error: error.message });
            });
        });
        
        this.cronJob.start();
        
        this.log('info', 'License verification scheduler started successfully');
    }

    /**
     * Stop the scheduler (for graceful shutdown)
     */
    stopScheduler() {
        if (this.cronJob) {
            this.cronJob.stop();
            this.log('info', 'License verification scheduler stopped');
        }
    }

    /**
     * Main verification cycle
     */
    async runVerificationCycle() {
        if (this.isRunning) {
            this.log('warn', 'Verification cycle already running, skipping');
            return;
        }

        const cycleId = Date.now();
        this.isRunning = true;
        
        try {
            this.log('info', 'Starting verification cycle', { cycleId });
            const startTime = Date.now();

            // Run verification tasks in sequence
            await this.verifyUserLicenses(cycleId);
            await this.verifyWebsiteLicenses(cycleId);

            const duration = Date.now() - startTime;
            this.log('info', 'Verification cycle completed', { 
                cycleId, 
                duration: `${duration}ms` 
            });
            
        } catch (error) {
            this.log('error', 'Verification cycle failed', { 
                cycleId, 
                error: error.message,
                stack: error.stack 
            });
        } finally {
            this.isRunning = false;
        }
    }

    /**
     * Verify user licenses.
     * - If USE_INTERNAL_LICENSE=true, use subscription_until in users table as truth.
     * - Otherwise, use existing WHMCS/licenseService checks.
     */
    async verifyUserLicenses(cycleId) {
        if (this.useInternal) {
            return this.verifyUserLicensesInternal(cycleId);
        }

        // original behaviour (external checks)
        try {
            const [usersToCheck] = await pool.query(
                `SELECT u.id, u.license_key, u.license_status, w.url AS websiteUrl 
                 FROM users u
                 LEFT JOIN websites w ON u.website_id = w.id
                 WHERE u.license_status IN ('active', 'suspended', 'expired', 'reissued', 'inactive', 'invalid')
                 AND u.license_key IS NOT NULL
                 AND u.license_key != ''`
            );

            this.log('info', 'Processing user licenses (external)', { 
                cycleId, 
                count: usersToCheck.length 
            });

            let updatedCount = 0;
            let errorCount = 0;

            // Process in batches to avoid overwhelming the API
            for (let i = 0; i < usersToCheck.length; i += this.batchSize) {
                const batch = usersToCheck.slice(i, i + this.batchSize);
                
                for (const user of batch) {
                    try {
                        if (!user.websiteUrl) {
                            this.log('debug', 'Skipping user - no website URL', { userId: user.id });
                            continue;
                        }

                        const hostname = this.extractHostname(user.websiteUrl);
                        const resolvedIp = await this.resolveDomainIp(hostname);

                        this.log('debug', 'Checking user license (external)', { 
                            userId: user.id,
                            currentStatus: user.license_status
                        });

                        const result = await this.licenseService.checkUserLicense(
                            user.license_key, 
                            { domain: hostname, ip: resolvedIp }
                        );

                        if (result.status !== user.license_status) {
                            await pool.execute(
                                "UPDATE users SET license_status = ?, updated_at = NOW() WHERE id = ?",
                                [result.status, user.id]
                            );
                            
                            updatedCount++;
                            this.log('info', 'User license status updated', {
                                userId: user.id,
                                oldStatus: user.license_status,
                                newStatus: result.status,
                                cycleId
                            });
                        }
                    } catch (userError) {
                        errorCount++;
                        this.log('error', 'User license check failed', {
                            userId: user.id,
                            error: userError.message,
                            cycleId
                        });
                    }
                }

                // Small delay between batches to avoid rate limiting
                if (i + this.batchSize < usersToCheck.length) {
                    await this.delay(1000);
                }
            }

            this.log('info', 'User license verification completed', {
                cycleId,
                processed: usersToCheck.length,
                updated: updatedCount,
                errors: errorCount
            });

        } catch (error) {
            this.log('error', 'User license verification failed', {
                cycleId,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Internal mode: verify users by subscription_until and update license_status to active/suspended.
     * This is a lightweight check — we don't call external services.
     */
    async verifyUserLicensesInternal(cycleId) {
        try {
            // select all users with a license_key (or who have subscription_until defined)
            const [usersToCheck] = await pool.query(
                `SELECT id, email, license_key, license_status, subscription_until
                 FROM users
                 WHERE (license_key IS NOT NULL AND license_key != '') OR subscription_until IS NOT NULL`
            );

            this.log('info', 'Processing user licenses (internal)', {
                cycleId,
                count: usersToCheck.length
            });

            let updatedCount = 0;
            let errorCount = 0;

            for (let i = 0; i < usersToCheck.length; i += this.batchSize) {
                const batch = usersToCheck.slice(i, i + this.batchSize);

                for (const user of batch) {
                    try {
                        const now = new Date();
                        const until = user.subscription_until ? new Date(user.subscription_until) : null;
                        let desiredStatus = 'suspended';

                        if (until && until > now) {
                            desiredStatus = 'active';
                        } else {
                            // no subscription_until or already past -> suspended
                            desiredStatus = 'suspended';
                        }

                        if (user.license_status !== desiredStatus) {
                            await pool.execute(
                                "UPDATE users SET license_status = ?, updated_at = NOW() WHERE id = ?",
                                [desiredStatus, user.id]
                            );

                            updatedCount++;
                            this.log('info', 'User license status updated (internal)', {
                                userId: user.id,
                                oldStatus: user.license_status,
                                newStatus: desiredStatus,
                                subscription_until: user.subscription_until,
                                cycleId
                            });
                        }
                    } catch (userError) {
                        errorCount++;
                        this.log('error', 'Internal user license check failed', {
                            userId: user.id,
                            error: userError.message,
                            cycleId
                        });
                    }
                }

                if (i + this.batchSize < usersToCheck.length) {
                    await this.delay(500); // shorter delay for internal checks
                }
            }

            this.log('info', 'Internal user license verification completed', {
                cycleId,
                processed: usersToCheck.length,
                updated: updatedCount,
                errors: errorCount
            });
        } catch (err) {
            this.log('error', 'Internal user license verification failed', { cycleId, error: err.message });
            throw err;
        }
    }

    /**
     * Verify website licenses with License Box (unchanged)
     */
    async verifyWebsiteLicenses(cycleId) {
        try {
            const [websitesToCheck] = await pool.query(
                `SELECT id, url, status, website_license_key, client_name 
                 FROM websites 
                 WHERE status IN ('approved', 'suspended')
                 AND website_license_key IS NOT NULL
                 AND website_license_key != ''`
            );

            this.log('info', 'Processing website licenses', {
                cycleId,
                count: websitesToCheck.length
            });

            let updatedCount = 0;
            let errorCount = 0;

            for (const website of websitesToCheck) {
                try {
                    this.log('debug', 'Checking website license', {
                        websiteId: website.id,
                        currentStatus: website.status
                    });

                    const result = await this.licenseService.checkWebsiteLicense(
                        website.website_license_key,
                        { 
                            websiteUrl: website.url, 
                            clientName: website.client_name 
                        }
                    );

                    const newStatus = result.isValid ? 'approved' : 'suspended';

                    if (newStatus !== website.status) {
                        await pool.execute(
                            "UPDATE websites SET status = ?, updated_at = NOW() WHERE id = ?",
                            [newStatus, website.id]
                        );
                        
                        updatedCount++;
                        this.log('info', 'Website license status updated', {
                            websiteId: website.id,
                            oldStatus: website.status,
                            newStatus: newStatus,
                            cycleId
                        });
                    }
                } catch (websiteError) {
                    errorCount++;
                    this.log('error', 'Website license check failed', {
                        websiteId: website.id,
                        error: websiteError.message,
                        cycleId
                    });
                }
            }

            this.log('info', 'Website license verification completed', {
                cycleId,
                processed: websitesToCheck.length,
                updated: updatedCount,
                errors: errorCount
            });

        } catch (error) {
            this.log('error', 'Website license verification failed', {
                cycleId,
                error: error.message
            });
            throw error;
        }
    }

    // Helper methods
    extractHostname(urlString) {
        try {
            // Handle URLs with protocol
            if (urlString.includes('://')) {
                const parsedUrl = new URL(urlString);
                return parsedUrl.hostname;
            }
            // Handle bare domains
            return urlString;
        } catch (error) {
            this.log('warn', 'Failed to parse URL', {
                url: urlString,
                error: error.message
            });
            return urlString;
        }
    }

    async resolveDomainIp(domain) {
        if (!domain) return '';

        try {
            const { address } = await dns.lookup(domain);
            return address;
        } catch (dnsError) {
            this.log('warn', 'Domain IP resolution failed', {
                domain,
                error: dnsError.message
            });
            return '';
        }
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    log(level, message, meta = {}) {
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            level: level.toUpperCase(),
            service: 'LicenseVerifier',
            message,
            ...meta
        };

        // JSON-structured logging for production
        console.log(JSON.stringify(logEntry));
    }

    /**
     * Manual trigger for verification cycle
     */
    async manualRun() {
        this.log('info', 'Manual verification triggered');
        await this.runVerificationCycle();
    }

    /**
     * Get scheduler status
     */
    getStatus() {
        return {
            isRunning: this.isRunning,
            isScheduled: this.cronJob !== null,
            useInternal: this.useInternal
        };
    }
}

// Create singleton instance
const licenseVerifier = new LicenseVerifier();

module.exports = licenseVerifier;
