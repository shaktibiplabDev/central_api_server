const { SlashCommandBuilder, EmbedBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { randomUUID } = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../config/database');
const settingsService = require('../services/settingsService');

// Helper function to create pagination buttons
function createPaginationButtons(page, totalPages, prefix) {
    return new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`${prefix}_prev_${page}`)
                .setLabel('◀ Previous')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page <= 1),
            new ButtonBuilder()
                .setCustomId(`${prefix}_page_${page}`)
                .setLabel(`Page ${page}/${totalPages}`)
                .setStyle(ButtonStyle.Primary)
                .setDisabled(true),
            new ButtonBuilder()
                .setCustomId(`${prefix}_next_${page}`)
                .setLabel('Next ▶')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page >= totalPages),
            new ButtonBuilder()
                .setCustomId(`${prefix}_close`)
                .setLabel('Close')
                .setStyle(ButtonStyle.Danger)
        );
}

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
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('info')
                .setDescription('Get detailed information about a specific website.')
                .addStringOption(option => option.setName('url').setDescription('The website URL or ID').setRequired(true))
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
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('submissions')
                .setDescription('Lists recent form submissions.')
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
        ),
    new SlashCommandBuilder()
        .setName('stats')
        .setDescription('Show system statistics and overview')
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
    'website.info': async (interaction) => {
        const identifier = interaction.options.getString('url');
        
        // Try to find by ID or URL
        const [websites] = await pool.query(
            "SELECT * FROM websites WHERE id = ? OR url = ? LIMIT 1", 
            [parseInt(identifier) || 0, identifier]
        );
        
        if (websites.length === 0) {
            return interaction.reply({ 
                content: `❌ No website found with identifier \`${identifier}\``, 
                flags: [MessageFlags.Ephemeral] 
            });
        }

        const website = websites[0];
        
        // Get associated users
        const [users] = await pool.query(
            "SELECT id, email, license_status, created_at FROM users WHERE website_id = ?",
            [website.id]
        );

        // Get submission stats
        const [submissionStats] = await pool.query(
            "SELECT COUNT(*) as total, status FROM submission_logs WHERE website_id = ? GROUP BY status",
            [website.id]
        );

        const embed = new EmbedBuilder()
            .setTitle(`🌐 Website Details: ${website.url}`)
            .setColor(0x0099FF)
            .addFields(
                { name: '🆔 ID', value: website.id.toString(), inline: true },
                { name: '📊 Status', value: website.status, inline: true },
                { name: '🔑 License Key', value: website.website_license_key || 'Not set', inline: true },
                { name: '👤 Client Name', value: website.client_name || 'Not set', inline: true },
                { name: '📅 Created', value: new Date(website.created_at).toLocaleDateString(), inline: true },
                { name: '🔄 Updated', value: new Date(website.updated_at).toLocaleDateString(), inline: true },
                { name: '👥 Associated Users', value: users.length.toString(), inline: true }
            );

        if (submissionStats.length > 0) {
            const statsText = submissionStats.map(stat => `${stat.status}: ${stat.total}`).join('\n');
            embed.addFields({ name: '📋 Submission Stats', value: statsText, inline: true });
        }

        if (users.length > 0) {
            const usersText = users.slice(0, 5).map(user => 
                `• ${user.email} (${user.license_status})`
            ).join('\n');
            if (users.length > 5) usersText += `\n... and ${users.length - 5} more`;
            embed.addFields({ name: '👤 Recent Users', value: usersText });
        }

        await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
    },
    'list.websites': async (interaction) => {
        const limit = Math.min(interaction.options.getInteger('limit') || 25, 50);
        const [websites] = await pool.query(
            'SELECT w.*, COUNT(u.id) as user_count FROM websites w LEFT JOIN users u ON w.id = u.website_id GROUP BY w.id ORDER BY w.id DESC LIMIT ?', 
            [limit]
        );
        
        if (websites.length === 0) return interaction.reply({ content: 'No websites found.', flags: [MessageFlags.Ephemeral] });
        
        const embed = new EmbedBuilder()
            .setTitle(`📊 Registered Websites (${websites.length})`)
            .setColor(0x0099FF)
            .setDescription(`Showing latest ${websites.length} websites`);

        websites.forEach(website => {
            embed.addFields({
                name: `🌐 ${website.url}`,
                value: `**ID:** ${website.id} | **Status:** ${website.status}\n**Users:** ${website.user_count} | **Created:** ${new Date(website.created_at).toLocaleDateString()}`,
                inline: false
            });
        });

        await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
    },
    'list.users': async (interaction) => {
        const limit = Math.min(interaction.options.getInteger('limit') || 25, 50);
        const [users] = await pool.query(
            `SELECT u.*, w.url, w.status as website_status 
             FROM users u 
             LEFT JOIN websites w ON u.website_id = w.id 
             ORDER BY u.id DESC LIMIT ?`, 
            [limit]
        );
        
        if (users.length === 0) return interaction.reply({ content: 'No users found.', flags: [MessageFlags.Ephemeral] });
        
        const embed = new EmbedBuilder()
            .setTitle(`👥 Registered Users (${users.length})`)
            .setColor(0x5865F2)
            .setDescription(`Showing latest ${users.length} users`);

        users.forEach(user => {
            embed.addFields({
                name: `📧 ${user.email}`,
                value: `**ID:** ${user.id} | **License:** ${user.license_status}\n**Website:** ${user.url || 'N/A'} (${user.website_status || 'N/A'})`,
                inline: false
            });
        });

        await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
    },
    'list.submissions': async (interaction) => {
        const limit = Math.min(interaction.options.getInteger('limit') || 25, 50);
        const [submissions] = await pool.query(
            `SELECT s.*, u.email, w.url 
             FROM submission_logs s 
             JOIN users u ON s.user_id = u.id 
             JOIN websites w ON s.website_id = w.id 
             ORDER BY s.submitted_at DESC LIMIT ?`, 
            [limit]
        );
        
        if (submissions.length === 0) return interaction.reply({ content: 'No submissions found.', flags: [MessageFlags.Ephemeral] });
        
        const embed = new EmbedBuilder()
            .setTitle(`📋 Recent Submissions (${submissions.length})`)
            .setColor(0x00FF00)
            .setDescription(`Showing latest ${submissions.length} submissions`);

        submissions.forEach(sub => {
            embed.addFields({
                name: `📄 ${sub.application_id} (${sub.form_type})`,
                value: `**User:** ${sub.email}\n**Website:** ${sub.url}\n**Status:** ${sub.status} | **Submitted:** ${new Date(sub.submitted_at).toLocaleString()}`,
                inline: false
            });
        });

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
    },
    'stats': async (interaction) => {
        // Get total counts
        const [[websiteCount]] = await pool.query('SELECT COUNT(*) as count FROM websites');
        const [[userCount]] = await pool.query('SELECT COUNT(*) as count FROM users');
        const [[submissionCount]] = await pool.query('SELECT COUNT(*) as count FROM submission_logs');
        
        // Get status breakdowns
        const [websiteStatus] = await pool.query('SELECT status, COUNT(*) as count FROM websites GROUP BY status');
        const [userStatus] = await pool.query('SELECT license_status, COUNT(*) as count FROM users GROUP BY license_status');
        
        const embed = new EmbedBuilder()
            .setTitle('📈 System Statistics')
            .setColor(0xFFA500)
            .setDescription('Current system overview and metrics')
            .addFields(
                { name: '🌐 Total Websites', value: websiteCount.count.toString(), inline: true },
                { name: '👥 Total Users', value: userCount.count.toString(), inline: true },
                { name: '📋 Total Submissions', value: submissionCount.count.toString(), inline: true }
            );

        if (websiteStatus.length > 0) {
            const websiteStats = websiteStatus.map(stat => `${stat.status}: ${stat.count}`).join('\n');
            embed.addFields({ name: '📊 Website Status', value: websiteStats, inline: true });
        }

        if (userStatus.length > 0) {
            const userStats = userStatus.map(stat => `${stat.license_status}: ${stat.count}`).join('\n');
            embed.addFields({ name: '🔐 User License Status', value: userStats, inline: true });
        }

        // Get recent activity
        const [recentSubmissions] = await pool.query(
            'SELECT COUNT(*) as count FROM submission_logs WHERE submitted_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)'
        );
        
        embed.addFields({ 
            name: '⏰ Last 24 Hours', 
            value: `Submissions: ${recentSubmissions[0].count}`,
            inline: true 
        });

        await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
    }
};

// Trigger command handlers (public with buttons)
const triggerHandlers = {
    '!websites': async (message) => {
        const limit = 10; // Show fewer for public commands
        const [websites] = await pool.query(
            'SELECT w.*, COUNT(u.id) as user_count FROM websites w LEFT JOIN users u ON w.id = u.website_id GROUP BY w.id ORDER BY w.created_at DESC LIMIT ?', 
            [limit]
        );
        
        if (websites.length === 0) {
            return message.reply('No websites found in the system.');
        }

        const totalPages = Math.ceil(websites.length / 5);
        const currentPage = 1;
        const pageWebsites = websites.slice(0, 5);

        const embed = new EmbedBuilder()
            .setTitle('🌐 Registered Websites')
            .setColor(0x0099FF)
            .setDescription(`Showing ${pageWebsites.length} of ${websites.length} websites`)
            .setFooter({ text: `Page ${currentPage}/${totalPages}` });

        pageWebsites.forEach(website => {
            embed.addFields({
                name: `${website.url} (${website.status})`,
                value: `**ID:** ${website.id} | **Users:** ${website.user_count}\n**Created:** ${new Date(website.created_at).toLocaleDateString()}`,
                inline: false
            });
        });

        const row = createPaginationButtons(currentPage, totalPages, 'websites');

        const sentMessage = await message.reply({ 
            embeds: [embed], 
            components: [row] 
        });

        return sentMessage;
    },
    '!stats': async (message) => {
        const [[websiteCount]] = await pool.query('SELECT COUNT(*) as count FROM websites');
        const [[userCount]] = await pool.query('SELECT COUNT(*) as count FROM users');
        const [[activeUsers]] = await pool.query("SELECT COUNT(*) as count FROM users WHERE license_status = 'active'");
        
        const [websiteStatus] = await pool.query('SELECT status, COUNT(*) as count FROM websites GROUP BY status');
        const [recentSubmissions] = await pool.query(
            'SELECT COUNT(*) as count FROM submission_logs WHERE submitted_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)'
        );

        const embed = new EmbedBuilder()
            .setTitle('📊 Public System Stats')
            .setColor(0x00FF00)
            .setDescription('Current system statistics')
            .addFields(
                { name: '🌐 Websites', value: websiteCount.count.toString(), inline: true },
                { name: '👥 Total Users', value: userCount.count.toString(), inline: true },
                { name: '✅ Active Users', value: activeUsers.count.toString(), inline: true },
                { name: '📨 24h Submissions', value: recentSubmissions[0].count.toString(), inline: true }
            );

        if (websiteStatus.length > 0) {
            const stats = websiteStatus.map(stat => `**${stat.status}**: ${stat.count}`).join(' | ');
            embed.addFields({ name: 'Website Status', value: stats });
        }

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('refresh_stats')
                    .setLabel('🔄 Refresh')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId('close_stats')
                    .setLabel('❌ Close')
                    .setStyle(ButtonStyle.Danger)
            );

        const sentMessage = await message.reply({ 
            embeds: [embed], 
            components: [row] 
        });

        return sentMessage;
    },
    '!website': async (message, args) => {
        if (args.length === 0) {
            return message.reply('Please provide a website URL or ID. Usage: `!website <url_or_id>`');
        }

        const identifier = args[0];
        const [websites] = await pool.query(
            "SELECT * FROM websites WHERE id = ? OR url LIKE ? LIMIT 1", 
            [parseInt(identifier) || 0, `%${identifier}%`]
        );
        
        if (websites.length === 0) {
            return message.reply(`No website found with identifier \`${identifier}\``);
        }

        const website = websites[0];
        const [users] = await pool.query(
            "SELECT id, email, license_status, created_at FROM users WHERE website_id = ? LIMIT 10",
            [website.id]
        );

        const [submissions] = await pool.query(
            "SELECT COUNT(*) as total FROM submission_logs WHERE website_id = ?",
            [website.id]
        );

        const embed = new EmbedBuilder()
            .setTitle(`🌐 Website: ${website.url}`)
            .setColor(0x0099FF)
            .addFields(
                { name: '🆔 ID', value: website.id.toString(), inline: true },
                { name: '📊 Status', value: website.status, inline: true },
                { name: '👤 Client', value: website.client_name || 'Not set', inline: true },
                { name: '👥 Users', value: users.length.toString(), inline: true },
                { name: '📋 Submissions', value: submissions[0].total.toString(), inline: true },
                { name: '📅 Created', value: new Date(website.created_at).toLocaleDateString(), inline: true }
            );

        if (users.length > 0) {
            const usersText = users.map(user => 
                `• ${user.email} (${user.license_status})`
            ).join('\n');
            embed.addFields({ 
                name: `Associated Users (${users.length})`, 
                value: usersText.length > 1024 ? usersText.substring(0, 1020) + '...' : usersText 
            });
        }

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`website_users_${website.id}`)
                    .setLabel('👥 View All Users')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId(`website_submissions_${website.id}`)
                    .setLabel('📋 View Submissions')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('close_website')
                    .setLabel('❌ Close')
                    .setStyle(ButtonStyle.Danger)
            );

        const sentMessage = await message.reply({ 
            embeds: [embed], 
            components: [row] 
        });

        return sentMessage;
    }
};

module.exports = { commands, handlers, triggerHandlers, createPaginationButtons };