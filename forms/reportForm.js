const { pool } = require('../config/database');
const axios = require('axios');

module.exports = {
    validate: async (data) => {
        const validTypes = ['bug', 'feedback', 'abuse'];
        if (!data.type || !validTypes.includes(data.type)) return `Invalid report type. Must be one of: ${validTypes.join(', ')}.`;
        if (!data.description || data.description.length < 10) return 'Description is required and must be at least 10 characters.';
        return null;
    },
    process: async (data, user) => {
        const [websites] = await pool.query("SELECT url, status, website_license_key FROM websites WHERE id = (SELECT website_id FROM users WHERE id = ?)", [user.id]);
        if (websites.length === 0 || websites[0].status !== 'approved') {
            throw new Error('User does not have an approved website for submissions.');
        }
        const website = websites[0];
        console.log(`[MOCK] Submitting report form to ${website.url} for user ${user.id}`);
        return { success: true, report_received: true, type: data.type };
    }
};