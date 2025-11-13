const { Client, GatewayIntentBits, Routes, REST, EmbedBuilder } = require('discord.js');
const { commands, handlers, handleComponentInteraction } = require('./commands');
const settingsService = require('../services/settingsService');

const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] 
});

client.once('ready', async () => {
    console.log(`✅ Discord Bot is ready! Logged in as ${client.user.tag}`);
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
        await rest.put(
            Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
            { body: commands },
        );
        console.log(`✅ Successfully registered ${commands.length} slash commands.`);
    } catch (error) {
        console.error('❌ Failed to register slash commands:', error);
    }
});

client.on('interactionCreate', async interaction => {
    try {
        // Handle component interactions (buttons, select menus) FIRST
        if (interaction.isButton() || interaction.isStringSelectMenu()) {
            console.log(`🔘 Component interaction: ${interaction.customId}`);
            const handled = await handleComponentInteraction(interaction);
            if (!handled) {
                console.log(`⚠️ Unhandled component interaction: ${interaction.customId}`);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ 
                        content: '❌ This button/menu is not functioning properly.', 
                        ephemeral: true 
                    });
                }
            }
            return;
        }
        
        // Handle slash commands
        if (interaction.isChatInputCommand()) {
            console.log(`🔄 Slash command: /${interaction.commandName} ${interaction.options.getSubcommand()}`);
            
            // Check admin permissions
            const ADMIN_ROLE_ID = await settingsService.get('DISCORD_ADMIN_ROLE_ID');
            if (!ADMIN_ROLE_ID || ADMIN_ROLE_ID === '0') {
                console.warn('⚠️ Admin role ID not configured properly');
                return interaction.reply({ 
                    content: '⛔ Admin role not configured. Please contact server administrator.', 
                    ephemeral: true 
                });
            }

            if (!interaction.member?.roles?.cache?.has(ADMIN_ROLE_ID)) {
                console.log(`🚫 Unauthorized access attempt by ${interaction.user.tag}`);
                return interaction.reply({ 
                    content: '⛔ You do not have permission to use admin commands.', 
                    ephemeral: true 
                });
            }

            // Build command key for subcommands
            const subcommand = interaction.options.getSubcommand(false);
            const commandKey = subcommand 
                ? `${interaction.commandName}.${subcommand}`
                : interaction.commandName;

            const handler = handlers[commandKey];
            
            if (handler) {
                console.log(`✅ Executing handler for: ${commandKey}`);
                await handler(interaction);
            } else {
                console.warn(`❌ No handler found for command: ${commandKey}`);
                await interaction.reply({ 
                    content: '❌ This command is not available at the moment.', 
                    ephemeral: true 
                });
            }
        }
    } catch (error) {
        console.error('💥 Unexpected error in interactionCreate:', error);
        
        try {
            const errorMessage = '❌ An unexpected error occurred. Please try again later.';
            
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ 
                    content: errorMessage, 
                    ephemeral: true 
                });
            } else {
                await interaction.reply({ 
                    content: errorMessage, 
                    ephemeral: true 
                });
            }
        } catch (followUpError) {
            console.error('💥 Critical: Failed to send error message:', followUpError);
        }
    }
});

// Handle other client events
client.on('error', (error) => {
    console.error('💥 Discord client error:', error);
});

client.on('warn', (warning) => {
    console.warn('⚠️ Discord client warning:', warning);
});

client.on('disconnect', (event) => {
    console.log(`🔌 Discord client disconnected: ${event.reason} (Code: ${event.code})`);
});

client.on('reconnecting', () => {
    console.log('🔄 Discord client reconnecting...');
});

/**
 * Send notification to Discord channel
 * @param {string} message - The message to send
 * @param {boolean} isEmbed - Whether to send as embed
 * @param {string} type - Type of notification (info, success, warning, error)
 */
async function sendNotification(message, isEmbed = false, type = 'info') {
    try {
        const channelId = await settingsService.get('DISCORD_NOTIF_CHANNEL_ID');
        if (!channelId || channelId === '0') {
            console.warn('⚠️ Discord Notification Channel ID is not configured. Skipping notification.');
            return false;
        }
        
        const channel = await client.channels.fetch(channelId);
        if (!channel) {
            console.error(`❌ Could not find notification channel with ID: ${channelId}`);
            return false;
        }

        if (!channel.isTextBased()) {
            console.error(`❌ Channel ${channelId} is not a text channel`);
            return false;
        }

        // Color mapping for notification types
        const colorMap = {
            info: 0x0099FF,
            success: 0x57F287,
            warning: 0xFEE75C,
            error: 0xED4245
        };

        if (isEmbed) {
            const embed = new EmbedBuilder()
                .setDescription(message)
                .setColor(colorMap[type] || colorMap.info)
                .setTimestamp()
                .setFooter({ text: 'System Notification' });

            await channel.send({ embeds: [embed] });
        } else {
            await channel.send(message);
        }

        console.log(`✅ Notification sent to channel ${channelId}`);
        return true;
    } catch (error) {
        console.error('❌ Failed to send Discord notification:', error);
        return false;
    }
}

/**
 * Send a formatted embed notification with title and fields
 * @param {string} title - The embed title
 * @param {string} description - The embed description
 * @param {Array} fields - Array of field objects {name, value, inline}
 * @param {string} color - Color hex code (optional)
 */
async function sendEmbedNotification(title, description, fields = [], color = null) {
    try {
        const channelId = await settingsService.get('DISCORD_NOTIF_CHANNEL_ID');
        if (!channelId || channelId === '0') {
            console.warn('⚠️ Discord Notification Channel ID is not configured. Skipping notification.');
            return false;
        }
        
        const channel = await client.channels.fetch(channelId);
        if (!channel) {
            console.error(`❌ Could not find notification channel with ID: ${channelId}`);
            return false;
        }

        if (!channel.isTextBased()) {
            console.error(`❌ Channel ${channelId} is not a text channel`);
            return false;
        }

        const embed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(description)
            .setColor(color || 0x0099FF)
            .setTimestamp();

        if (fields.length > 0) {
            embed.addFields(fields);
        }

        await channel.send({ embeds: [embed] });
        console.log(`✅ Embed notification sent to channel ${channelId}`);
        return true;
    } catch (error) {
        console.error('❌ Failed to send embed notification:', error);
        return false;
    }
}

/**
 * Check if bot is ready and connected
 * @returns {boolean} Bot connection status
 */
function isBotReady() {
    return client.isReady();
}

/**
 * Get bot uptime in human readable format
 * @returns {string} Formatted uptime
 */
function getUptime() {
    if (!client.readyTimestamp) return 'Not connected';
    
    const uptime = Date.now() - client.readyTimestamp;
    const days = Math.floor(uptime / 86400000);
    const hours = Math.floor(uptime / 3600000) % 24;
    const minutes = Math.floor(uptime / 60000) % 60;
    const seconds = Math.floor(uptime / 1000) % 60;

    return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

module.exports = { 
    client, 
    sendNotification, 
    sendEmbedNotification,
    isBotReady,
    getUptime 
};