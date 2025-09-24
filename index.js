require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');

// Import core modules
const synchronizeDb = require('./database/synchronize');
const { client } = require('./bot/bot');
const settingsService = require('./services/settingsService');
const licenseVerifier = require('./services/licenseVerifier');
const apiRoutes = require('./routes/api');
const { pool } = require('./config/database');

const startServer = async () => {
    console.log('--- Starting Application Server ---');

    // Step 1: Critical sequential startup
    await synchronizeDb();
    await settingsService.load();

    // Step 2: Prepare express
    const app = express();
    app.use(helmet());
    app.use(cors());
    app.use(express.json());

    // Static + routes
    app.use(express.static(path.join(__dirname, 'public')));
    app.use('/api', apiRoutes);
    app.use('/downloads', express.static(path.join(__dirname, 'public/downloads')));

    // Step 3: Run independent tasks in parallel
    const preferredPort = parseInt(process.env.PORT, 10) || 3000;

    await Promise.allSettled([
        (async () => {
            const actualPort = await findPortAndListen(app, preferredPort);
            console.log(`✅ Express server is running on port ${actualPort}`);
        })(),
        (async () => {
            await client.login(process.env.DISCORD_BOT_TOKEN);
            console.log('✅ Discord bot logged in');
        })(),
        (async () => {
            licenseVerifier.start();
            console.log('✅ License verifier started');
        })()
    ]);

    console.log('--- ✅ Application is fully operational. ---');
};

function findPortAndListen(app, port) {
    return new Promise((resolve, reject) => {
        const server = app.listen(port, () => {
            resolve(port);
        });
        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.warn(`⚠️ Port ${port} is busy, trying port ${port + 1}...`);
                server.close(() => {
                    findPortAndListen(app, port + 1).then(resolve).catch(reject);
                });
            } else {
                reject(err);
            }
        });
    });
}

startServer().catch(error => {
    console.error('❌ FATAL APPLICATION STARTUP ERROR:', error);
    process.exit(1);
});

process.on('SIGINT', async () => {
    console.log('\nShutting down server gracefully...');
    await pool.end();
    client.destroy();
    process.exit(0);
});