require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const os = require('os');

// Import core modules
const synchronizeDb = require('./database/synchronize');
const { client } = require('./bot/bot');
const settingsService = require('./services/settingsService');
const licenseVerifier = require('./services/licenseVerifier');
const apiRoutes = require('./routes/api');
const { pool } = require('./config/database');

class ApplicationServer {
    constructor() {
        this.app = express();
        this.server = null;
        this.isShuttingDown = false;
        this.startTime = Date.now();
        
        this.setupExpress();
        this.setupErrorHandling();
    }

    setupExpress() {
        // Security middleware
        this.app.use(helmet({
            contentSecurityPolicy: {
                directives: {
                    defaultSrc: ["'self'"],
                    styleSrc: ["'self'", "'unsafe-inline'"],
                    scriptSrc: ["'self'"],
                    imgSrc: ["'self'", "data:", "https:"],
                },
            },
            crossOriginEmbedderPolicy: false
        }));

        // CORS configuration
        this.app.use(cors({
            origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : true,
            credentials: true,
            methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
        }));

        // Body parsing middleware with limits
        this.app.use(express.json({
            limit: process.env.MAX_REQUEST_SIZE || '10mb',
            verify: (req, res, buf) => {
                req.rawBody = buf;
            }
        }));

        this.app.use(express.urlencoded({
            extended: true,
            limit: process.env.MAX_REQUEST_SIZE || '10mb'
        }));

        // Static files
        this.app.use(express.static(path.join(__dirname, 'public'), {
            maxAge: process.env.NODE_ENV === 'production' ? '1d' : '0',
            etag: true,
            lastModified: true
        }));

        // Health check endpoint
        this.app.get('/health', (req, res) => {
            if (this.isShuttingDown) {
                return res.status(503).json({
                    status: 'shutting_down',
                    uptime: process.uptime(),
                    timestamp: new Date().toISOString()
                });
            }

            res.json({
                status: 'healthy',
                uptime: process.uptime(),
                timestamp: new Date().toISOString(),
                memory: process.memoryUsage(),
                version: process.env.npm_package_version || '1.0.0'
            });
        });

        // Ready check endpoint for load balancers
        this.app.get('/ready', (req, res) => {
            if (this.isShuttingDown) {
                return res.status(503).json({ status: 'not_ready' });
            }
            res.json({ status: 'ready' });
        });

        // API routes
        this.app.use('/api', apiRoutes);

        // Downloads route
        this.app.use('/downloads', express.static(path.join(__dirname, 'public/downloads'), {
            maxAge: '7d',
            setHeaders: (res, path) => {
                if (path.endsWith('.zip')) {
                    res.set('Content-Type', 'application/zip');
                }
            }
        }));

        // 404 handler
        this.app.use('*', (req, res) => {
            res.status(404).json({
                error: 'Route not found',
                path: req.originalUrl,
                timestamp: new Date().toISOString()
            });
        });

        // Global error handler
        this.app.use((error, req, res, next) => {
            console.error('Unhandled error:', {
                error: error.message,
                stack: error.stack,
                url: req.url,
                method: req.method,
                ip: req.ip
            });

            res.status(error.status || 500).json({
                error: process.env.NODE_ENV === 'production' 
                    ? 'Internal server error' 
                    : error.message,
                ...(process.env.NODE_ENV !== 'production' && { stack: error.stack })
            });
        });
    }

    setupErrorHandling() {
        // Uncaught exception handler
        process.on('uncaughtException', (error) => {
            console.error('UNCAUGHT EXCEPTION:', {
                error: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString()
            });
            
            if (process.env.NODE_ENV === 'production') {
                process.exit(1);
            }
        });

        // Unhandled promise rejection handler
        process.on('unhandledRejection', (reason, promise) => {
            console.error('UNHANDLED PROMISE REJECTION:', {
                reason: reason?.message || reason,
                promise,
                timestamp: new Date().toISOString()
            });
            
            if (process.env.NODE_ENV === 'production') {
                process.exit(1);
            }
        });

        // SIGTERM handler (for Kubernetes, Docker, etc.)
        process.on('SIGTERM', () => {
            console.log('Received SIGTERM, starting graceful shutdown...');
            this.gracefulShutdown();
        });

        // SIGINT handler (Ctrl+C)
        process.on('SIGINT', () => {
            console.log('Received SIGINT, starting graceful shutdown...');
            this.gracefulShutdown();
        });
    }

    async start() {
        try {
            console.log('--- Starting Application Server ---');
            console.log('Environment:', process.env.NODE_ENV || 'development');
            console.log('Node version:', process.version);
            console.log('Platform:', `${os.platform()}/${os.arch()}`);
            console.log('CPU cores:', os.cpus().length);
            console.log('Memory:', `${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB`);

            // Step 1: Critical sequential startup
            console.log('🔄 Step 1: Database synchronization...');
            await this.withTimeout(synchronizeDb(), 30000, 'Database synchronization');
            
            console.log('🔄 Step 2: Loading settings...');
            await this.withTimeout(settingsService.load(), 10000, 'Settings loading');

            // Step 2: Start services in parallel with proper error handling
            console.log('🔄 Step 3: Starting services...');
            
            const preferredPort = parseInt(process.env.PORT, 10) || 3000;
            
            const startupTasks = [
                this.startExpressServer(preferredPort),
                this.startDiscordBot(),
                this.startLicenseVerifier()
            ];

            const results = await Promise.allSettled(startupTasks);

            // Check for failures
            const failures = results.filter(result => result.status === 'rejected');
            if (failures.length > 0) {
                failures.forEach((failure, index) => {
                    console.error(`❌ Service ${index} failed to start:`, failure.reason);
                });
                throw new Error(`${failures.length} service(s) failed to start`);
            }

            // 🧩 Internal subscription system integration
            if (process.env.USE_INTERNAL_LICENSE === 'true') {
                try {
                    const { startOrderPoller } = require('./jobs/orderStatusPoller');
                    const { startScheduler } = require('./jobs/licenseChecker');
                    
                    startOrderPoller();
                    startScheduler();

                    console.log('✅ Internal subscription jobs started (order poller & license scheduler).');
                } catch (e) {
                    console.error('⚠️ Failed to start internal subscription jobs', e);
                }
            }

            console.log('--- ✅ Application is fully operational ---');
            console.log('Startup time:', `${Date.now() - this.startTime}ms`);
            console.log('Uptime started at:', new Date().toISOString());

        } catch (error) {
            console.error('❌ FATAL APPLICATION STARTUP ERROR:', error);
            await this.gracefulShutdown();
            process.exit(1);
        }
    }

    async startExpressServer(preferredPort) {
        return new Promise((resolve, reject) => {
            const server = this.app.listen(preferredPort, (err) => {
                if (err) {
                    if (err.code === 'EADDRINUSE') {
                        console.warn(`⚠️ Port ${preferredPort} is busy, trying ${preferredPort + 1}...`);
                        this.startExpressServer(preferredPort + 1).then(resolve).catch(reject);
                        return;
                    }
                    reject(err);
                    return;
                }
                
                this.server = server;
                console.log(`✅ Express server running on port ${preferredPort}`);
                resolve(preferredPort);
            });

            server.on('error', reject);
        });
    }

    async startDiscordBot() {
        if (!process.env.DISCORD_BOT_TOKEN) {
            console.warn('⚠️ DISCORD_BOT_TOKEN not set, skipping Discord bot startup');
            return 'skipped';
        }

        try {
            await this.withTimeout(
                client.login(process.env.DISCORD_BOT_TOKEN),
                15000,
                'Discord bot login'
            );
            console.log('✅ Discord bot logged in successfully');
            return 'started';
        } catch (error) {
            console.error('❌ Discord bot failed to start:', error.message);
            throw error;
        }
    }

    async startLicenseVerifier() {
        try {
            licenseVerifier.startScheduler();
            console.log('✅ License verifier scheduler started');
            return 'started';
        } catch (error) {
            console.error('❌ License verifier failed to start:', error.message);
            throw error;
        }
    }

    async withTimeout(promise, ms, taskName) {
        const timeout = new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error(`${taskName} timed out after ${ms}ms`));
            }, ms);
        });

        return Promise.race([promise, timeout]);
    }

    async gracefulShutdown() {
        if (this.isShuttingDown) return;
        
        this.isShuttingDown = true;
        console.log('Initiating graceful shutdown...');

        const shutdownStart = Date.now();
        const shutdownPromises = [];

        // Stop accepting new connections
        if (this.server) {
            console.log('Closing HTTP server...');
            shutdownPromises.push(new Promise((resolve) => {
                this.server.close((err) => {
                    if (err) {
                        console.error('Error closing HTTP server:', err);
                    } else {
                        console.log('HTTP server closed');
                    }
                    resolve();
                });
            }));
        }

        // Stop Discord bot
        if (client && client.destroy) {
            console.log('Disconnecting Discord bot...');
            shutdownPromises.push(Promise.resolve().then(() => {
                client.destroy();
                console.log('Discord bot disconnected');
            }));
        }

        // Stop license verifier
        if (licenseVerifier && licenseVerifier.stopScheduler) {
            console.log('Stopping license verifier...');
            shutdownPromises.push(Promise.resolve().then(() => {
                licenseVerifier.stopScheduler();
                console.log('License verifier stopped');
            }));
        }

        // Close database connections
        if (pool && pool.end) {
            console.log('Closing database connections...');
            shutdownPromises.push(pool.end().then(() => {
                console.log('Database connections closed');
            }).catch(error => {
                console.error('Error closing database connections:', error);
            }));
        }

        // Wait for all shutdown tasks with timeout
        try {
            await Promise.race([
                Promise.allSettled(shutdownPromises),
                new Promise(resolve => setTimeout(resolve, 30000)) // 30s timeout
            ]);
        } catch (error) {
            console.error('Error during shutdown:', error);
        }

        console.log(`Graceful shutdown completed in ${Date.now() - shutdownStart}ms`);
    }
}

// Application startup
const appServer = new ApplicationServer();

// Handle any startup errors
appServer.start().catch(async (error) => {
    console.error('Failed to start application:', error);
    await appServer.gracefulShutdown();
    process.exit(1);
});

// Export for testing
module.exports = appServer;
