const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { randomUUID } = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../config/database');
const settingsService = require('../services/settingsService');

const commands = [
    new SlashCommandBuilder()
        .setName('app')
        .setDescription('Manage the mobile application.')
        .addSubcommand(subcommand =>
            subcommand
                .setName('update')
                .setDescription('Initiates the process to upload a new app version.')
                .addStringOption(option => option.setName('version').setDescription('The new version number (e.g., 1.2.0)').setRequired(true))
        ),
    new SlashCommandBuilder()
        .setName('website')
        .setDescription('Manually manage a website.')
        .addSubcommand(subcommand =>
            subcommand
                .setName('force-approve')
                .setDescription('Manually approves a website and sets its license key.')
                .addStringOption(option => option.setName('url').setDescription('The full URL of the website').setRequired(true))
                .addStringOption(option => option.setName('license_key').setDescription('The correct website license key to assign').setRequired(true))
        ),
    new SlashCommandBuilder()
        .setName('list')
        .setDescription('Lists data from the database.')
        .addSubcommand(subcommand =>
            subcommand
                .setName('websites')
                .setDescription('Lists all registered websites and their status.')
                .addIntegerOption(option => option.setName('limit').setDescription('How many results to show (default 25).'))
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('users')
                .setDescription('Lists all registered users and their status.')
                .addIntegerOption(option => option.setName('limit').setDescription('How many results to show (default 25).'))
        ),
    new SlashCommandBuilder()
        .setName('settings')
        .setDescription('Manage application settings')
        .addSubcommand(subcommand => subcommand.setName('view').setDescription('View all current settings'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('set')
                .setDescription('Update a setting value')
                .addStringOption(option => option.setName('key').setDescription('The setting key to update').setRequired(true))
                .addStringOption(option => option.setName('value').setDescription('The new value for the setting').setRequired(true))
        )
].map(command => command.toJSON());

const handlers = {
    'app.update': async (interaction) => {
        const version = interaction.options.getString('version');
        const uploadToken = randomUUID();
        const plainTextPassword = `upload-${Math.floor(1000 + Math.random() * 9000)}`;
        const hashedPassword = await bcrypt.hash(plainTextPassword, 10);
        const expiresAt = new Date(Date.now() + 3600 * 1000); // 1 hour expiration

        await pool.query(
            "INSERT INTO app_uploads (version, token, password_hash, expires_at) VALUES (?, ?, ?, ?)",
            [version, uploadToken, hashedPassword, expiresAt]
        );

        // --- THIS IS THE CORRECTED LOGIC FOR POSTMAN ---
        const serverBaseUrl = process.env.SERVER_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
        const uploadApiUrl = `${serverBaseUrl}/api/app-upload?token=${uploadToken}`;
        
        await interaction.reply({
            content: `✅ **App Upload Session Created for v${version}**\n\n` +
                     `Use the following details in Postman to upload the APK file within the next hour.\n\n` +
                     `**Method:** \`POST\`\n` +
                     `**URL:** \`${uploadApiUrl}\`\n\n` +
                     `**Headers Tab:**\n` +
                     `Key: \`X-Upload-Password\`\n` +
                     `Value: \`${plainTextPassword}\`\n\n` +
                     `**Body Tab (form-data):**\n` +
                     `Key: \`apkfile\` (change type to 'File')\n` +
                     `Value: *Select your .apk file*\n\n` +
                     `*This session will expire in one hour.*`,
            flags: [MessageFlags.Ephemeral]
        });
    },
    'website.force-approve': async (interaction) => {
        const url = interaction.options.getString('url');
        const licenseKey = interaction.options.getString('license_key');
        const [result] = await pool.query("UPDATE websites SET status = 'approved', website_license_key = ? WHERE url = ?", [licenseKey, url]);
        if (result.affectedRows === 0) return interaction.reply({ content: `❌ No website found with URL \`${url}\`. A user must register from it first.`, flags: [MessageFlags.Ephemeral] });
        await interaction.reply({ content: `✅ Website \`${url}\` has been manually force-approved with the provided license key.`, flags: [MessageFlags.Ephemeral] });
    },
    'list.websites': async (interaction) => {
        const limit = interaction.options.getInteger('limit') || 25;
        const [websites] = await pool.query('SELECT id, url, status FROM websites ORDER BY id DESC LIMIT ?', [limit]);
        if (websites.length === 0) return interaction.reply({ content: 'No websites found.', flags: [MessageFlags.Ephemeral] });
        const embed = new EmbedBuilder().setTitle(`📊 Registered Websites (Last ${websites.length})`).setColor(0x0099FF);
        const description = websites.map(w => `**ID ${w.id}**: \`${w.url}\` - **Status:** ${w.status}`).join('\n');
        embed.setDescription(description);
        await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
    },
    'list.users': async (interaction) => {
        const limit = interaction.options.getInteger('limit') || 25;
        const [users] = await pool.query(`SELECT u.id, u.email, u.license_status, w.url FROM users u LEFT JOIN websites w ON u.website_id = w.id ORDER BY u.id DESC LIMIT ?`, [limit]);
        if (users.length === 0) return interaction.reply({ content: 'No users found.', flags: [MessageFlags.Ephemeral] });
        const embed = new EmbedBuilder().setTitle(`👥 Registered Users (Last ${users.length})`).setColor(0x5865F2);
        const description = users.map(u => `**ID ${u.id}**: \`${u.email}\` - **License:** ${u.license_status}\n*Website: ${u.url || 'N/A'}*`).join('\n\n');
        embed.setDescription(description);
        await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
    },
    'settings.view': async (interaction) => {
        const allSettings = settingsService.getAll();
        const settingsList = Object.entries(allSettings).map(([key, value]) => `**${key}**: \`${value}\``).join('\n');
        await interaction.reply({ content: `⚙️ **Current Application Settings**\n${settingsList}`, flags: [MessageFlags.Ephemeral] });
    },
    'settings.set': async (interaction) => {
        const key = interaction.options.getString('key');
        const value = interaction.options.getString('value');
        await settingsService.set(key, value);
        await interaction.reply({ content: `✅ Setting \`${key}\` has been updated to \`${value}\`.`, flags: [MessageFlags.Ephemeral] });
    }
};

module.exports = { commands, handlers };

