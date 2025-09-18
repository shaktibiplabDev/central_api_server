const DB_SCHEMA = {
    creationOrder: ['websites', 'users', 'app_settings', 'app_uploads'],
    tables: {
        websites: {
            columns: `
                id INT AUTO_INCREMENT PRIMARY KEY,
                url VARCHAR(255) NOT NULL UNIQUE,
                status ENUM('pending', 'approved', 'rejected', 'suspended') DEFAULT 'pending',
                website_license_key VARCHAR(255) UNIQUE,
                client_name VARCHAR(100) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            `
        },
        users: {
            columns: `
                id INT AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(255) NOT NULL UNIQUE,
                password_hash VARCHAR(255) NOT NULL,
                license_key VARCHAR(255) NOT NULL UNIQUE,
                license_status ENUM('active', 'inactive', 'suspended', 'expired', 'reissued') DEFAULT 'inactive',
                last_license_check TIMESTAMP NULL,
                website_id INT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (website_id) REFERENCES websites(id) ON DELETE SET NULL
            `
        },
        app_settings: {
            columns: `
                setting_key VARCHAR(50) PRIMARY KEY,
                setting_value VARCHAR(255) NOT NULL,
                description TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            `,
            seed: [
                { setting_key: 'DISCORD_ADMIN_ROLE_ID', setting_value: '0', description: 'Replace with your Admin Role ID.' },
                { setting_key: 'DISCORD_NOTIF_CHANNEL_ID', setting_value: '0', description: 'Replace with your Notification Channel ID.' },
                { setting_key: 'LICENSE_CHECK_INTERVAL_MS', setting_value: '300000', description: 'License check interval in ms (5 minutes).' },
                { setting_key: 'APP_LATEST_VERSION', setting_value: '1.0.0', description: 'The most current version of the mobile app (e.g., 1.0.0).' },
                { setting_key: 'APP_FORCE_UPDATE_BELOW', setting_value: '1.0.0', description: 'Force any app version below this to update.' },
                { setting_key: 'APP_DOWNLOAD_URL', setting_value: 'https://your-site.com/downloads/app.apk', description: 'The public URL to download the latest APK.' }
            ]
        },
        app_uploads: {
            columns: `
                id INT AUTO_INCREMENT PRIMARY KEY,
                version VARCHAR(50) NOT NULL,
                token VARCHAR(255) NOT NULL UNIQUE,
                password_hash VARCHAR(255) NOT NULL,
                status ENUM('pending', 'completed', 'expired') DEFAULT 'pending',
                expires_at TIMESTAMP NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            `
        }
    }
};

module.exports = DB_SCHEMA;