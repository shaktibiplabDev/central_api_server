const { Client, GatewayIntentBits, Routes, REST, EmbedBuilder, Collection } = require('discord.js');
const { commands, handlers, triggerHandlers, createPaginationButtons } = require('./commands');
const settingsService = require('../services/settingsService');

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ] 
});

// Store active messages for button interactions
client.activeMessages = new Collection();

client.once('ready', async () => {
    console.log(`✅ Discord Bot is ready! Logged in as ${client.user.tag}`);
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
        await rest.put(
            Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
            { body: commands },
        );
        console.log('Successfully registered slash commands.');
    } catch (error) {
        console.error('Failed to register slash commands:', error);
    }
});

client.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand()) {
        await handleSlashCommand(interaction);
    } else if (interaction.isButton()) {
        await handleButtonInteraction(interaction);
    }
});

client.on('messageCreate', async message => {
    // Ignore messages from bots and without prefix
    if (message.author.bot) return;
    if (!message.content.startsWith('!')) return;

    // Check for admin role for trigger commands too
    const ADMIN_ROLE_ID = settingsService.get('DISCORD_ADMIN_ROLE_ID');
    if (!ADMIN_ROLE_ID || ADMIN_ROLE_ID === '0' || !message.member.roles.cache.has(ADMIN_ROLE_ID)) {
        return message.reply('⛔ You do not have permission to use this command.').then(msg => {
            setTimeout(() => msg.delete(), 5000);
        });
    }

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    if (triggerHandlers[command]) {
        try {
            const sentMessage = await triggerHandlers[command](message, args);
            if (sentMessage) {
                // Store message for button interactions (expire after 15 minutes)
                client.activeMessages.set(sentMessage.id, {
                    originalMessage: message,
                    sentMessage: sentMessage,
                    timestamp: Date.now(),
                    type: command,
                    data: args
                });

                // Clean up after 15 minutes
                setTimeout(() => {
                    client.activeMessages.delete(sentMessage.id);
                }, 15 * 60 * 1000);
            }
        } catch (error) {
            console.error(`Error executing trigger command ${command}:`, error);
            message.reply('An error occurred while executing the command.').then(msg => {
                setTimeout(() => msg.delete(), 5000);
            });
        }
    }
});

async function handleSlashCommand(interaction) {
    const ADMIN_ROLE_ID = settingsService.get('DISCORD_ADMIN_ROLE_ID');
    if (!ADMIN_ROLE_ID || ADMIN_ROLE_ID === '0' || !interaction.member.roles.cache.has(ADMIN_ROLE_ID)) {
        return interaction.reply({ content: '⛔ You do not have permission to use this command.', ephemeral: true });
    }

    const commandKey = `${interaction.commandName}.${interaction.options.getSubcommand()}`;
    const handler = handlers[commandKey] || handlers[interaction.commandName];
    
    if (handler) {
        try {
            await handler(interaction);
        } catch (error) {
            console.error(`Error executing command ${commandKey}:`, error);
            const replyOptions = { content: 'An error occurred while executing the command.', ephemeral: true };
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(replyOptions);
            } else {
                await interaction.reply(replyOptions);
            }
        }
    }
}

async function handleButtonInteraction(interaction) {
    const { customId } = interaction;
    const [type, action, ...rest] = customId.split('_');
    
    try {
        switch (type) {
            case 'websites':
                await handleWebsitesPagination(interaction, action, rest);
                break;
            case 'refresh':
                if (action === 'stats') {
                    await refreshStats(interaction);
                }
                break;
            case 'website':
                await handleWebsiteDetails(interaction, action, rest);
                break;
            case 'close':
                await interaction.message.delete();
                break;
            default:
                await interaction.reply({ content: 'Unknown button action.', ephemeral: true });
        }
    } catch (error) {
        console.error('Error handling button interaction:', error);
        await interaction.reply({ content: 'An error occurred.', ephemeral: true });
    }
}

async function handleWebsitesPagination(interaction, action, params) {
    const { pool } = require('../config/database');
    const [currentPage] = params;
    let newPage = parseInt(currentPage);

    if (action === 'prev') newPage--;
    if (action === 'next') newPage++;

    const limit = 10;
    const [websites] = await pool.query(
        'SELECT w.*, COUNT(u.id) as user_count FROM websites w LEFT JOIN users u ON w.id = u.website_id GROUP BY w.id ORDER BY w.created_at DESC LIMIT ? OFFSET ?', 
        [limit, (newPage - 1) * 5]
    );

    const totalPages = Math.ceil(limit / 5);
    
    const embed = new EmbedBuilder()
        .setTitle('🌐 Registered Websites')
        .setColor(0x0099FF)
        .setDescription(`Showing websites ${(newPage - 1) * 5 + 1}-${Math.min(newPage * 5, limit)} of ${limit}`)
        .setFooter({ text: `Page ${newPage}/${totalPages}` });

    websites.slice(0, 5).forEach(website => {
        embed.addFields({
            name: `${website.url} (${website.status})`,
            value: `**ID:** ${website.id} | **Users:** ${website.user_count}\n**Created:** ${new Date(website.created_at).toLocaleDateString()}`,
            inline: false
        });
    });

    const row = createPaginationButtons(newPage, totalPages, 'websites');

    await interaction.update({ embeds: [embed], components: [row] });
}

async function refreshStats(interaction) {
    const { pool } = require('../config/database');
    
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

    await interaction.update({ embeds: [embed], components: [row] });
}

async function handleWebsiteDetails(interaction, action, params) {
    const { pool } = require('../config/database');
    const [websiteId] = params;

    if (action === 'users') {
        const [users] = await pool.query(
            "SELECT id, email, license_status, created_at FROM users WHERE website_id = ?",
            [websiteId]
        );

        const embed = new EmbedBuilder()
            .setTitle(`👥 Users for Website ID: ${websiteId}`)
            .setColor(0x5865F2)
            .setDescription(`Total users: ${users.length}`);

        users.forEach(user => {
            embed.addFields({
                name: user.email,
                value: `**Status:** ${user.license_status} | **Joined:** ${new Date(user.created_at).toLocaleDateString()}`,
                inline: true
            });
        });

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('close_details')
                    .setLabel('❌ Close')
                    .setStyle(ButtonStyle.Danger)
            );

        await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    }
}

async function sendNotification(message, isEmbed = false) {
    try {
        const channelId = settingsService.get('DISCORD_NOTIF_CHANNEL_ID');
        if (!channelId || channelId === '0') {
            console.warn('Discord Notification Channel ID is not configured. Skipping notification.');
            return;
        }
        
        const channel = await client.channels.fetch(channelId);
        if (!channel) {
            console.error(`Could not find notification channel with ID: ${channelId}`);
            return;
        }

        if (isEmbed) {
            const embed = new EmbedBuilder().setDescription(message).setColor(0x0099FF).setTimestamp();
            await channel.send({ embeds: [embed] });
        } else {
            await channel.send(message);
        }
    } catch (error) {
        console.error('Failed to send Discord notification:', error);
    }
}

// Clean up old messages periodically
setInterval(() => {
    const now = Date.now();
    for (const [messageId, data] of client.activeMessages.entries()) {
        if (now - data.timestamp > 15 * 60 * 1000) { // 15 minutes
            client.activeMessages.delete(messageId);
        }
    }
}, 60 * 1000); // Run every minute

module.exports = { client, sendNotification };