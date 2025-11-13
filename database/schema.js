// schema.js
const DB_SCHEMA = {
    creationOrder: [
        'websites',
        'users',
        'app_settings',
        'app_uploads',
        'submission_logs',
        'pending_users',
        'invoices',
        'payments',
        'license_history'
    ],

    tables: {
        websites: {
            // per-column definitions so we can check and add individually
            columns: [
                { name: 'id', def: 'INT NOT NULL AUTO_INCREMENT PRIMARY KEY' },
                { name: 'url', def: 'VARCHAR(255) NOT NULL UNIQUE' },
                { name: 'status', def: "ENUM('pending','approved','rejected','suspended') DEFAULT 'pending'" },
                { name: 'website_license_key', def: 'VARCHAR(255) DEFAULT NULL UNIQUE' },
                { name: 'client_name', def: 'VARCHAR(100) DEFAULT NULL' },
                { name: 'created_at', def: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' },
                { name: 'updated_at', def: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP' }
            ]
        },

        users: {
            columns: [
                { name: 'id', def: 'INT NOT NULL AUTO_INCREMENT PRIMARY KEY' },
                { name: 'email', def: 'VARCHAR(255) NOT NULL UNIQUE' },
                { name: 'password_hash', def: 'VARCHAR(255) NOT NULL' },
                { name: 'license_key', def: 'VARCHAR(255) DEFAULT NULL UNIQUE' },
                { name: 'license_status', def: "ENUM('active','inactive','suspended','expired','reissued') DEFAULT 'inactive'" },
                { name: 'last_license_check', def: 'TIMESTAMP NULL DEFAULT NULL' },
                { name: 'website_id', def: 'INT DEFAULT NULL' },
                { name: 'created_at', def: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' },
                { name: 'updated_at', def: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP' },
                { name: 'subscription_until', def: 'DATETIME DEFAULT NULL' },
                { name: 'phone', def: 'VARCHAR(50) DEFAULT NULL' }
            ],
            // indexes/foreign keys to ensure after columns exist
            indexes: [
                { type: 'KEY', name: 'website_id', columns: ['website_id'] }
            ],
            fks: [
                { name: 'users_ibfk_1', column: 'website_id', refTable: 'websites', refColumn: 'id', onDelete: 'SET NULL' }
            ]
        },

        app_settings: {
            columns: [
                { name: 'setting_key', def: 'VARCHAR(50) NOT NULL PRIMARY KEY' },
                { name: 'setting_value', def: 'VARCHAR(255) NOT NULL' },
                { name: 'description', def: 'TEXT DEFAULT NULL' },
                { name: 'updated_at', def: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP' }
            ],
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
            columns: [
                { name: 'id', def: 'INT NOT NULL AUTO_INCREMENT PRIMARY KEY' },
                { name: 'version', def: 'VARCHAR(50) NOT NULL' },
                { name: 'token', def: 'VARCHAR(255) NOT NULL UNIQUE' },
                { name: 'password_hash', def: 'VARCHAR(255) NOT NULL' },
                { name: 'status', def: "ENUM('pending','completed','expired') DEFAULT 'pending'" },
                { name: 'expires_at', def: 'TIMESTAMP NOT NULL' },
                { name: 'created_at', def: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' }
            ]
        },

        submission_logs: {
            columns: [
                { name: 'id', def: 'INT NOT NULL AUTO_INCREMENT PRIMARY KEY' },
                { name: 'user_id', def: 'INT NOT NULL' },
                { name: 'website_id', def: 'INT NOT NULL' },
                { name: 'form_type', def: 'VARCHAR(50) NOT NULL' },
                { name: 'application_id', def: 'VARCHAR(100) NOT NULL' },
                { name: 'status', def: "VARCHAR(50) DEFAULT 'submitted'" },
                { name: 'submitted_at', def: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' }
            ],
            indexes: [
                { type: 'KEY', name: 'user_id', columns: ['user_id'] },
                { type: 'KEY', name: 'website_id', columns: ['website_id'] }
            ],
            fks: [
                { name: 'submission_logs_ibfk_1', column: 'user_id', refTable: 'users', refColumn: 'id', onDelete: 'CASCADE' },
                { name: 'submission_logs_ibfk_2', column: 'website_id', refTable: 'websites', refColumn: 'id', onDelete: 'CASCADE' }
            ]
        },

        pending_users: {
            columns: [
                { name: 'id', def: 'BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY' },
                { name: 'email', def: 'VARCHAR(255) NOT NULL' },
                { name: 'password_hash', def: 'VARCHAR(255) NOT NULL' },
                { name: 'phone', def: 'VARCHAR(50) DEFAULT NULL' },
                { name: 'website_id', def: 'BIGINT DEFAULT NULL' },
                { name: 'meta', def: 'LONGTEXT DEFAULT NULL' }, // some MySQL versions: use LONGTEXT for json compatibility, app code can parse JSON
                { name: 'created_at', def: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' }
            ],
            indexes: [
                { type: 'KEY', name: 'idx_pending_users_website_id', columns: ['website_id'] }
            ]
        },

        invoices: {
            columns: [
                { name: 'id', def: 'BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY' },
                { name: 'invoice_no', def: 'VARCHAR(128) NOT NULL UNIQUE' },
                { name: 'user_id', def: 'INT DEFAULT NULL' },
                { name: 'pending_user_id', def: 'BIGINT DEFAULT NULL' },
                { name: 'amount', def: 'DECIMAL(12,2) NOT NULL' },
                { name: 'purpose', def: 'VARCHAR(64) NOT NULL' },
                { name: 'status', def: "ENUM('pending','paid','failed','cancelled') DEFAULT 'pending'" },
                { name: 'gateway_provider', def: 'VARCHAR(64) DEFAULT NULL' },
                { name: 'gateway_response', def: 'LONGTEXT DEFAULT NULL' },
                { name: 'created_at', def: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' },
                { name: 'paid_at', def: 'TIMESTAMP NULL DEFAULT NULL' }
            ],
            indexes: [
                { type: 'KEY', name: 'user_id', columns: ['user_id'] },
                { type: 'KEY', name: 'pending_user_id', columns: ['pending_user_id'] }
            ],
            fks: [
                { name: 'invoices_ibfk_1', column: 'user_id', refTable: 'users', refColumn: 'id', onDelete: 'SET NULL' },
                { name: 'invoices_ibfk_2', column: 'pending_user_id', refTable: 'pending_users', refColumn: 'id', onDelete: 'SET NULL' }
            ]
        },

        payments: {
            columns: [
                { name: 'id', def: 'BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY' },
                { name: 'invoice_id', def: 'BIGINT NOT NULL' },
                { name: 'provider_transaction_id', def: 'VARCHAR(255) DEFAULT NULL' },
                { name: 'provider_response', def: 'LONGTEXT DEFAULT NULL' },
                { name: 'amount', def: 'DECIMAL(12,2) DEFAULT NULL' },
                { name: 'status', def: "ENUM('success','failed','pending') DEFAULT 'pending'" },
                { name: 'created_at', def: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' }
            ],
            indexes: [
                { type: 'KEY', name: 'invoice_id', columns: ['invoice_id'] }
            ],
            fks: [
                { name: 'payments_ibfk_1', column: 'invoice_id', refTable: 'invoices', refColumn: 'id', onDelete: 'CASCADE' }
            ]
        },

        license_history: {
            columns: [
                { name: 'id', def: 'BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY' },
                { name: 'user_id', def: 'INT NOT NULL' },
                { name: 'license_key', def: 'VARCHAR(255) DEFAULT NULL' },
                { name: 'action', def: 'VARCHAR(80) NOT NULL' },
                { name: 'note', def: 'VARCHAR(255) DEFAULT NULL' },
                { name: 'created_at', def: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' }
            ],
            fks: [
                { name: 'license_history_ibfk_1', column: 'user_id', refTable: 'users', refColumn: 'id', onDelete: 'CASCADE' }
            ]
        }
    }
};

module.exports = DB_SCHEMA;
