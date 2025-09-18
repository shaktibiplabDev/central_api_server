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

// Main async function to control startup order
const startServer = async () => {
    console.log('--- Starting Application Server ---');

    await synchronizeDb();
    await settingsService.load();

    const app = express();
    app.use(helmet());
    app.use(cors());
    app.use(express.json());
    
    // Serve static files from the public directory FIRST
    app.use(express.static(path.join(__dirname, 'public')));
    
    // Then add your API routes
    app.use('/api', apiRoutes);

    // Make the 'downloads' folder publicly accessible with specific route
    app.use('/downloads', express.static(path.join(__dirname, 'public/downloads')));

    try {
        const preferredPort = parseInt(process.env.PORT, 10) || 3000;
        const actualPort = await findPortAndListen(app, preferredPort);
        console.log(`✅ Express server is running on port ${actualPort}`);
    } catch (error) {
        console.error('❌ Could not start Express server:', error);
        process.exit(1);
    }

    await client.login(process.env.DISCORD_BOT_TOKEN);
    licenseVerifier.start();

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