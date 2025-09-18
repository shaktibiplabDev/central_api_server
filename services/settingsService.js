const { pool } = require('../config/database');
let settingsCache = {};

const service = {
    load: async () => {
        try {
            const [rows] = await pool.query('SELECT setting_key, setting_value FROM app_settings');
            settingsCache = rows.reduce((acc, row) => {
                acc[row.setting_key] = row.setting_value;
                return acc;
            }, {});
            console.log('✅ Application settings loaded into cache.');
        } catch (error) {
            console.error('❌ Failed to load application settings:', error);
            process.exit(1);
        }
    },
    get: (key) => settingsCache[key],
    getAll: () => settingsCache,
    set: async (key, value) => {
        await pool.query(
            'INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
            [key, value, value]
        );
        settingsCache[key] = value;
        return true;
    },
};
module.exports = service;