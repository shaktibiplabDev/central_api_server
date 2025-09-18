const { pool } = require('../config/database');
const axios = require('axios');

module.exports = {
    validate: async (data) => {
        if (!data.title || data.title.length < 3) return 'Title is required and must be at least 3 characters.';
        if (!data.content) return 'Content is required.';
        return null;
    },
    process: async (data, user) => {
        const [websites] = await pool.query("SELECT url, status, website_license_key FROM websites WHERE id = (SELECT website_id FROM users WHERE id = ?)", [user.id]);
        if (websites.length === 0 || websites[0].status !== 'approved') {
            throw new Error('User does not have an approved website for submissions.');
        }
        const website = websites[0];
        console.log(`[MOCK] Submitting entry form to ${website.url} for user ${user.id}`);
        return { success: true, submitted: data, transactionId: `mock-${Date.now()}` };
    }
};