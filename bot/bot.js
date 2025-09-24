const { Client, GatewayIntentBits, Routes, REST, EmbedBuilder } = require('discord.js');
const { commands, handlers } = require('./commands');
const settingsService = require('../services/settingsService');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

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
    if (!interaction.isChatInputCommand()) return;
    
    const ADMIN_ROLE_ID = settingsService.get('DISCORD_ADMIN_ROLE_ID');
    if (!ADMIN_ROLE_ID || ADMIN_ROLE_ID === '0' || !interaction.member.roles.cache.has(ADMIN_ROLE_ID)) {
        return interaction.reply({ content: '⛔ You do not have permission to use this command.', ephemeral: true });
    }

    // This logic handles commands with subcommands correctly (e.g., /list users)
    const commandKey = `${interaction.commandName}.${interaction.options.getSubcommand()}`;
    const handler = handlers[commandKey];
    
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
});

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

module.exports = { client, sendNotification };
