// adminCommands.js
const { SlashCommandBuilder, EmbedBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, AttachmentBuilder } = require('discord.js');
const { randomUUID } = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../config/database');
const settingsService = require('../services/settingsService');

const { createCanvas } = require('canvas'); // node-canvas for invoice rendering

// -------------------------
// Slash command definitions
// -------------------------
const commands = [
    new SlashCommandBuilder()
        .setName('app')
        .setDescription('Manage the mobile application.')
        .addSubcommand(subcommand =>
            subcommand
                .setName('update')
                .setDescription('Initiates the process to upload a new app version.')
                .addStringOption(option => 
                    option.setName('version')
                        .setDescription('The new version number (e.g., 1.2.0)')
                        .setRequired(true)
                )
        ),

    new SlashCommandBuilder()
        .setName('website')
        .setDescription('Manually manage a website.')
        .addSubcommand(subcommand =>
            subcommand
                .setName('force-approve')
                .setDescription('Manually approves a website and sets its license key.')
                .addStringOption(option => 
                    option.setName('url')
                        .setDescription('The full URL of the website')
                        .setRequired(true)
                )
                .addStringOption(option => 
                    option.setName('license_key')
                        .setDescription('The correct website license key to assign')
                        .setRequired(true)
                )
        ),

    new SlashCommandBuilder()
        .setName('list')
        .setDescription('Lists data from the database.')
        .addSubcommand(sub =>
            sub
                .setName('websites')
                .setDescription('Lists all registered websites and their status.')
                .addIntegerOption(option => 
                    option.setName('limit')
                        .setDescription('How many results to show (default 25).')
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('users')
                .setDescription('Lists all registered users and their status.')
                .addIntegerOption(option => 
                    option.setName('page')
                        .setDescription('Page number (default 1)')
                )
                .addIntegerOption(option => 
                    option.setName('per_page')
                        .setDescription('Results per page (default 10; max 50)')
                )
        ),

    new SlashCommandBuilder()
        .setName('settings')
        .setDescription('Manage application settings')
        .addSubcommand(subcommand => 
            subcommand.setName('view')
                .setDescription('View all current settings')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('set')
                .setDescription('Update a setting value')
                .addStringOption(option => 
                    option.setName('key')
                        .setDescription('The setting key to update')
                        .setRequired(true)
                )
                .addStringOption(option => 
                    option.setName('value')
                        .setDescription('The new value for the setting')
                        .setRequired(true)
                )
        ),

    // User management - consolidated single command definition
    new SlashCommandBuilder()
        .setName('user')
        .setDescription('User management (admin only).')
        .addSubcommand(sub =>
            sub.setName('view')
                .setDescription('View full details about a user.')
                .addStringOption(opt => 
                    opt.setName('email')
                        .setDescription('Email of the user')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('extend-sub')
                .setDescription('Extend a user subscription by months.')
                .addStringOption(opt => 
                    opt.setName('email')
                        .setDescription('Email of the user')
                        .setRequired(true)
                )
                .addIntegerOption(opt => 
                    opt.setName('months')
                        .setDescription('Number of months to extend')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('set-subscription')
                .setDescription('Set custom subscription until date for a user.')
                .addStringOption(opt => 
                    opt.setName('email')
                        .setDescription('Email of the user')
                        .setRequired(true)
                )
                .addStringOption(opt => 
                    opt.setName('date')
                        .setDescription('Date in YYYY-MM-DD format')
                        .setRequired(true)
                )
        ),

    // Invoice tools
    new SlashCommandBuilder()
        .setName('invoice')
        .setDescription('Invoice tools (admin only).')
        .addSubcommand(sub =>
            sub.setName('print')
                .setDescription('Render an invoice as an image (PNG) and send it.')
                .addStringOption(opt => 
                    opt.setName('invoice_no')
                        .setDescription('Invoice number')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('List recent invoices.')
                .addIntegerOption(opt => 
                    opt.setName('limit')
                        .setDescription('How many invoices to show (default 25)')
                )
        )
].map(cmd => cmd.toJSON());

// -------------------------
// Handlers object
// -------------------------
const handlers = {};

// -------------------------
// Helper: isAdmin
// -------------------------
async function isAdmin(interaction) {
    try {
        const adminRoleId = await settingsService.get('DISCORD_ADMIN_ROLE_ID');
        if (!adminRoleId || adminRoleId === '0') {
            console.warn('Admin role ID not configured');
            return false;
        }
        
        // Check if interaction is in a guild and user has admin role
        if (!interaction.member || !interaction.member.roles || !interaction.member.roles.cache) {
            return false;
        }
        
        return interaction.member.roles.cache.has(adminRoleId);
    } catch (error) {
        console.error('isAdmin check failed:', error);
        return false;
    }
}

// -------------------------
// Helper: validateAdmin
// -------------------------
async function validateAdmin(interaction) {
    if (!await isAdmin(interaction)) {
        await interaction.reply({ 
            content: '❌ You do not have permission to use this command.', 
            flags: [MessageFlags.Ephemeral] 
        });
        return false;
    }
    return true;
}

// -------------------------
// Helper: renderInvoicePNG
// -------------------------
async function renderInvoicePNG(invoice, payments = [], user = null) {
    const width = 800;
    const height = 1120;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Color scheme
    const colors = {
        primary: '#2563eb',
        secondary: '#64748b',
        accent: '#10b981',
        background: '#ffffff',
        header: '#1e293b',
        text: '#334155',
        lightText: '#64748b',
        border: '#e2e8f0',
        success: '#059669',
        warning: '#d97706',
        danger: '#dc2626'
    };

    // Helper function to draw rounded rectangles
    const roundedRect = (x, y, width, height, radius) => {
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + width - radius, y);
        ctx.arcTo(x + width, y, x + width, y + radius, radius);
        ctx.lineTo(x + width, y + height - radius);
        ctx.arcTo(x + width, y + height, x + width - radius, y + height, radius);
        ctx.lineTo(x + radius, y + height);
        ctx.arcTo(x, y + height, x, y + height - radius, radius);
        ctx.lineTo(x, y + radius);
        ctx.arcTo(x, y, x + radius, y, radius);
        ctx.closePath();
    };

    // Background with subtle gradient
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#f8fafc');
    gradient.addColorStop(1, '#ffffff');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    // Header with accent bar
    ctx.fillStyle = colors.primary;
    ctx.fillRect(0, 0, width, 120);

    // Invoice title
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 32px sans-serif';
    ctx.fillText('INVOICE', 40, 60);

    // Invoice number in header
    ctx.font = '18px sans-serif';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.fillText(`#${invoice.invoice_no}`, 40, 90);

    // Main content area
    const contentStartY = 160;

    // Invoice details card
    ctx.fillStyle = colors.background;
    roundedRect(40, contentStartY, width - 80, 120, 12);
    ctx.fill();

    // Add shadow effect
    ctx.shadowColor = 'rgba(0, 0, 0, 0.1)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 2;
    ctx.fill();
    ctx.shadowColor = 'transparent';

    // Stroke for card
    ctx.strokeStyle = colors.border;
    roundedRect(40, contentStartY, width - 80, 120, 12);
    ctx.stroke();

    // Invoice details
    ctx.font = '16px sans-serif';
    ctx.fillStyle = colors.text;

    const detailsY = contentStartY + 30;
    ctx.fillText(`Date: ${invoice.created_at ? new Date(invoice.created_at).toLocaleDateString() : 'N/A'}`, 60, detailsY);

    // Payment date if paid
    if (invoice.paid_at) {
        ctx.fillText(`Paid: ${new Date(invoice.paid_at).toLocaleDateString()}`, 60, detailsY + 25);
    } else {
        ctx.fillText(`Due: Upon receipt`, 60, detailsY + 25);
    }

    ctx.fillText(`Status:`, 60, detailsY + 50);

    // Status badge
    ctx.fillStyle = invoice.status === 'paid' ? colors.success :
        invoice.status === 'pending' ? colors.warning :
            invoice.status === 'failed' ? colors.danger : colors.secondary;
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText(invoice.status.toUpperCase(), 120, detailsY + 50);

    // Amount summary on right side of card
    const amountX = width - 240;
    ctx.font = 'bold 18px sans-serif';
    ctx.fillStyle = colors.header;
    ctx.fillText('TOTAL AMOUNT', amountX, detailsY);
    ctx.font = 'bold 24px sans-serif';
    ctx.fillStyle = colors.primary;
    ctx.fillText(`₹${Number(invoice.amount).toFixed(2)}`, amountX, detailsY + 30);

    // Billed to section
    const billedToY = contentStartY + 160;
    ctx.font = 'bold 20px sans-serif';
    ctx.fillStyle = colors.header;
    ctx.fillText('Billed To:', 40, billedToY);

    ctx.fillStyle = colors.background;
    roundedRect(40, billedToY + 20, width - 80, 100, 8);
    ctx.fill();
    ctx.strokeStyle = colors.border;
    roundedRect(40, billedToY + 20, width - 80, 100, 8);
    ctx.stroke();

    ctx.font = '16px sans-serif';
    ctx.fillStyle = colors.text;
    const userY = billedToY + 50;
    ctx.fillText(user ? user.email : 'Guest User', 60, userY);
    if (user && user.phone) {
        ctx.fillText(`Phone: ${user.phone}`, 60, userY + 25);
    }

    // Payment summary - Calculate based on ACTUAL SUCCESSFUL payments only
    const paymentSummaryY = billedToY + 150;
    ctx.fillStyle = colors.background;
    roundedRect(40, paymentSummaryY, width - 80, 120, 12);
    ctx.fill();
    ctx.strokeStyle = colors.border;
    roundedRect(40, paymentSummaryY, width - 80, 120, 12);
    ctx.stroke();

    // Calculate payment totals from SUCCESSFUL payments only
    let totalPaid = 0;
    let paymentMethod = 'N/A';
    let gatewayTransactionId = 'N/A';

    // Filter only successful payments
    const successfulPayments = payments.filter(p =>
        p.status === 'success' || p.status === 'completed' || p.status === 'paid'
    );

    if (successfulPayments.length > 0) {
        totalPaid = successfulPayments.reduce((sum, payment) => {
            return sum + Number(payment.amount || 0);
        }, 0);

        // Get payment method from the first successful payment
        const successfulPayment = successfulPayments[0];
        paymentMethod = successfulPayment.gateway_provider || 'Online Payment';
        gatewayTransactionId = successfulPayment.gateway_transaction_id ||
            (successfulPayment.gateway_response ?
                JSON.parse(successfulPayment.gateway_response).result?.gateway_txn : 'N/A');
    } else if (invoice.status === 'paid' && invoice.gateway_response) {
        // Fallback: if invoice is marked paid but no successful payments found
        try {
            const gatewayData = JSON.parse(invoice.gateway_response);
            if (gatewayData.result && gatewayData.result.amount) {
                totalPaid = Number(gatewayData.result.amount);
                paymentMethod = gatewayData.result.method || invoice.gateway_provider || 'Online Payment';
                gatewayTransactionId = gatewayData.result.gateway_txn || 'N/A';
            }
        } catch (e) {
            // If parsing fails, use invoice amount for paid invoices
            if (invoice.status === 'paid') {
                totalPaid = Number(invoice.amount);
            }
        }
    }

    const dueAmount = Number(invoice.amount) - totalPaid;

    ctx.font = 'bold 18px sans-serif';
    ctx.fillStyle = colors.header;
    ctx.fillText('PAYMENT SUMMARY', 60, paymentSummaryY + 30);

    ctx.font = '16px sans-serif';
    ctx.fillStyle = colors.text;
    ctx.fillText(`Invoice Amount:`, 60, paymentSummaryY + 60);
    ctx.fillText(`Amount Paid:`, 60, paymentSummaryY + 85);
    ctx.fillText(`Balance Due:`, 60, paymentSummaryY + 110);

    ctx.font = 'bold 16px sans-serif';
    ctx.fillStyle = colors.text;
    ctx.fillText(`₹${Number(invoice.amount).toFixed(2)}`, 200, paymentSummaryY + 60);
    ctx.fillStyle = totalPaid > 0 ? colors.success : colors.text;
    ctx.fillText(`₹${Number(totalPaid).toFixed(2)}`, 200, paymentSummaryY + 85);
    ctx.fillStyle = dueAmount > 0 ? colors.warning : colors.success;
    ctx.fillText(`₹${Math.max(0, dueAmount).toFixed(2)}`, 200, paymentSummaryY + 110);

    // Payment details section
    const paymentDetailsY = paymentSummaryY + 140;
    ctx.font = 'bold 18px sans-serif';
    ctx.fillStyle = colors.header;
    ctx.fillText('PAYMENT DETAILS', 40, paymentDetailsY);

    ctx.fillStyle = colors.background;
    roundedRect(40, paymentDetailsY + 20, width - 80, 80, 8);
    ctx.fill();
    ctx.strokeStyle = colors.border;
    roundedRect(40, paymentDetailsY + 20, width - 80, 80, 8);
    ctx.stroke();

    ctx.font = '14px sans-serif';
    ctx.fillStyle = colors.text;
    ctx.fillText(`Payment Method: ${paymentMethod}`, 60, paymentDetailsY + 45);
    ctx.fillText(`Transaction ID: ${gatewayTransactionId}`, 60, paymentDetailsY + 70);

    // Payment history table (show ALL payments but highlight successful ones)
    const tableStartY = paymentDetailsY + 120;

    if (payments && payments.length > 0) {
        ctx.font = 'bold 18px sans-serif';
        ctx.fillStyle = colors.header;
        ctx.fillText('PAYMENT ATTEMPTS', 40, tableStartY);

        // Table header
        ctx.fillStyle = colors.primary;
        roundedRect(40, tableStartY + 30, width - 80, 40, 8);
        ctx.fill();

        ctx.font = 'bold 14px sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.fillText('Date', 60, tableStartY + 55);
        ctx.fillText('Transaction ID', 180, tableStartY + 55);
        ctx.fillText('Amount', 400, tableStartY + 55);
        ctx.fillText('Status', 500, tableStartY + 55);

        // Table rows - show all payment attempts
        let rowY = tableStartY + 80;
        payments.forEach((payment, index) => {
            const isSuccessful = payment.status === 'success' || payment.status === 'completed' || payment.status === 'paid';

            ctx.fillStyle = index % 2 === 0 ? '#ffffff' : '#f8fafc';
            roundedRect(40, rowY, width - 80, 40, 8);
            ctx.fill();
            ctx.strokeStyle = colors.border;
            roundedRect(40, rowY, width - 80, 40, 8);
            ctx.stroke();

            const date = payment.created_at ? new Date(payment.created_at).toLocaleDateString() :
                payment.paid_at ? new Date(payment.paid_at).toLocaleDateString() : 'N/A';

            const txnId = payment.gateway_transaction_id ||
                (payment.gateway_response ?
                    JSON.parse(payment.gateway_response).result?.gateway_txn : '-');

            const amount = payment.amount != null ? `₹${Number(payment.amount).toFixed(2)}` : '₹0.00';

            ctx.font = '14px sans-serif';
            ctx.fillStyle = colors.text;
            ctx.fillText(date, 60, rowY + 25);
            ctx.fillText(txnId.length > 12 ? txnId.substring(0, 12) + '...' : txnId, 180, rowY + 25);
            ctx.fillText(amount, 400, rowY + 25);

            // Status badge with different colors
            ctx.font = 'bold 12px sans-serif';
            if (isSuccessful) {
                ctx.fillStyle = colors.success;
            } else if (payment.status === 'failed') {
                ctx.fillStyle = colors.danger;
            } else {
                ctx.fillStyle = colors.warning;
            }
            ctx.fillText(payment.status.toUpperCase(), 500, rowY + 25);

            rowY += 50;
        });
    }

    // Footer
    const footerY = height - 80;
    ctx.strokeStyle = colors.border;
    ctx.beginPath();
    ctx.moveTo(40, footerY);
    ctx.lineTo(width - 40, footerY);
    ctx.stroke();

    ctx.font = '14px sans-serif';
    ctx.fillStyle = colors.lightText;
    ctx.textAlign = 'center';
    ctx.fillText('Thank you for your business!', width / 2, footerY + 30);
    ctx.font = '12px sans-serif';
    ctx.fillText('Generated by Central API', width / 2, footerY + 50);
    ctx.textAlign = 'left';

    return canvas.toBuffer('image/png');
}

// -------------------------
// Helper: buildUsersPagePayload
// -------------------------
async function buildUsersPagePayload(page = 1, per_page = 10) {
    try {
        const safePer = Math.min(50, Math.max(1, per_page));
        const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM users');
        const totalPages = Math.max(1, Math.ceil(total / safePer));
        const currentPage = Math.min(Math.max(1, page), totalPages);
        const offset = (currentPage - 1) * safePer;

        const [users] = await pool.query(
            `SELECT u.id, u.email, u.license_status, u.subscription_until, w.url as website_url
             FROM users u
             LEFT JOIN websites w ON u.website_id = w.id
             ORDER BY u.id DESC
             LIMIT ? OFFSET ?`, 
            [safePer, offset]
        );

        const embed = new EmbedBuilder()
            .setTitle(`👥 Registered Users — page ${currentPage}/${totalPages}`)
            .setColor(0x5865F2);

        const description = users.map(u => {
            const subUntil = u.subscription_until ? new Date(u.subscription_until).toISOString().split('T')[0] : 'N/A';
            return `**ID ${u.id}**: \`${u.email}\` — **License:** ${u.license_status} — *Website:* ${u.website_url || 'N/A'} — *Sub:* ${subUntil}`;
        }).join('\n\n');

        embed.setDescription(description || 'No users on this page.');
        embed.setFooter({ text: `Showing ${users.length} of ${total} users • per_page=${safePer}` });

        const prevButton = new ButtonBuilder()
            .setCustomId(`users_pagination|${currentPage - 1}|${safePer}`)
            .setLabel('◀ Prev')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(currentPage <= 1);

        const nextButton = new ButtonBuilder()
            .setCustomId(`users_pagination|${currentPage + 1}|${safePer}`)
            .setLabel('Next ▶')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(currentPage >= totalPages);

        const perPageMenu = new StringSelectMenuBuilder()
            .setCustomId(`users_perpage|${currentPage}`)
            .setPlaceholder(`Per page: ${safePer}`)
            .addOptions([
                { label: '5 per page', value: '5' },
                { label: '10 per page', value: '10' },
                { label: '25 per page', value: '25' },
                { label: '50 per page', value: '50' },
            ]);

        const row1 = new ActionRowBuilder().addComponents(prevButton, nextButton);
        const row2 = new ActionRowBuilder().addComponents(perPageMenu);

        return { embeds: [embed], components: [row1, row2] };
    } catch (error) {
        console.error('Error building users page payload:', error);
        throw new Error('Failed to build users page');
    }
}

// -------------------------
// Command handlers
// -------------------------
handlers['app.update'] = async (interaction) => {
    if (!await validateAdmin(interaction)) return;

    try {
        const version = interaction.options.getString('version');
        
        // Validate version format
        if (!/^\d+\.\d+\.\d+$/.test(version)) {
            return interaction.reply({ 
                content: '❌ Invalid version format. Please use semantic versioning (e.g., 1.2.0).', 
                flags: [MessageFlags.Ephemeral] 
            });
        }

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
    } catch (error) {
        console.error('Error in app.update:', error);
        await interaction.reply({ 
            content: '❌ Failed to create app upload session. Please try again.', 
            flags: [MessageFlags.Ephemeral] 
        });
    }
};

handlers['website.force-approve'] = async (interaction) => {
    if (!await validateAdmin(interaction)) return;

    try {
        const url = interaction.options.getString('url');
        const licenseKey = interaction.options.getString('license_key');

        // Validate URL format
        try {
            new URL(url);
        } catch (error) {
            return interaction.reply({ 
                content: '❌ Invalid URL format. Please provide a valid URL.', 
                flags: [MessageFlags.Ephemeral] 
            });
        }

        const [result] = await pool.query(
            "UPDATE websites SET status = 'approved', website_license_key = ? WHERE url = ?", 
            [licenseKey, url]
        );
        
        if (result.affectedRows === 0) {
            return interaction.reply({ 
                content: `❌ No website found with URL \`${url}\`. A user must register from it first.`, 
                flags: [MessageFlags.Ephemeral] 
            });
        }
        
        await interaction.reply({ 
            content: `✅ Website \`${url}\` has been manually force-approved with the provided license key.`, 
            flags: [MessageFlags.Ephemeral] 
        });
    } catch (error) {
        console.error('Error in website.force-approve:', error);
        await interaction.reply({ 
            content: '❌ Failed to approve website. Please try again.', 
            flags: [MessageFlags.Ephemeral] 
        });
    }
};

handlers['list.websites'] = async (interaction) => {
    if (!await validateAdmin(interaction)) return;

    try {
        const limit = Math.min(100, Math.max(1, interaction.options.getInteger('limit') || 25));
        const [websites] = await pool.query(
            'SELECT id, url, status FROM websites ORDER BY id DESC LIMIT ?', 
            [limit]
        );
        
        if (websites.length === 0) {
            return interaction.reply({ 
                content: 'No websites found.', 
                flags: [MessageFlags.Ephemeral] 
            });
        }
        
        const embed = new EmbedBuilder()
            .setTitle(`📊 Registered Websites (Last ${websites.length})`)
            .setColor(0x0099FF);
            
        const description = websites.map(w => 
            `**ID ${w.id}**: \`${w.url}\` - **Status:** ${w.status}`
        ).join('\n');
        
        embed.setDescription(description);
        await interaction.reply({ 
            embeds: [embed], 
            flags: [MessageFlags.Ephemeral] 
        });
    } catch (error) {
        console.error('Error in list.websites:', error);
        await interaction.reply({ 
            content: '❌ Failed to fetch websites. Please try again.', 
            flags: [MessageFlags.Ephemeral] 
        });
    }
};

handlers['list.users'] = async (interaction) => {
    if (!await validateAdmin(interaction)) return;

    try {
        const page = Math.max(1, interaction.options.getInteger('page') || 1);
        const perPageRequested = interaction.options.getInteger('per_page') || 10;
        const per_page = Math.min(50, Math.max(1, perPageRequested));
        
        const payload = await buildUsersPagePayload(page, per_page);
        await interaction.reply({ 
            ...payload, 
            flags: [MessageFlags.Ephemeral] 
        });
    } catch (error) {
        console.error('Error in list.users:', error);
        await interaction.reply({ 
            content: '❌ Failed to fetch users. Please try again.', 
            flags: [MessageFlags.Ephemeral] 
        });
    }
};

handlers['settings.view'] = async (interaction) => {
    if (!await validateAdmin(interaction)) return;

    try {
        const allSettings = await settingsService.getAll();
        const settingsList = Object.entries(allSettings)
            .map(([key, value]) => `**${key}**: \`${value}\``)
            .join('\n');
            
        await interaction.reply({ 
            content: `⚙️ **Current Application Settings**\n${settingsList}`, 
            flags: [MessageFlags.Ephemeral] 
        });
    } catch (error) {
        console.error('Error in settings.view:', error);
        await interaction.reply({ 
            content: '❌ Failed to fetch settings. Please try again.', 
            flags: [MessageFlags.Ephemeral] 
        });
    }
};

handlers['settings.set'] = async (interaction) => {
    if (!await validateAdmin(interaction)) return;

    try {
        const key = interaction.options.getString('key');
        const value = interaction.options.getString('value');
        
        await settingsService.set(key, value);
        await interaction.reply({ 
            content: `✅ Setting \`${key}\` has been updated to \`${value}\`.`, 
            flags: [MessageFlags.Ephemeral] 
        });
    } catch (error) {
        console.error('Error in settings.set:', error);
        await interaction.reply({ 
            content: '❌ Failed to update setting. Please try again.', 
            flags: [MessageFlags.Ephemeral] 
        });
    }
};

handlers['user.view'] = async (interaction) => {
    if (!await validateAdmin(interaction)) return;

    try {
        const email = interaction.options.getString('email');
        
        // Basic email validation
        if (!email.includes('@')) {
            return interaction.reply({ 
                content: '❌ Please provide a valid email address.', 
                flags: [MessageFlags.Ephemeral] 
            });
        }

        const [[user]] = await pool.query(
            `SELECT u.*, w.url as website_url
             FROM users u
             LEFT JOIN websites w ON u.website_id = w.id
             WHERE u.email = ? LIMIT 1`, 
            [email]
        );

        if (!user) {
            return interaction.reply({ 
                content: `❌ No user found for \`${email}\`.`, 
                flags: [MessageFlags.Ephemeral] 
            });
        }

        const [history] = await pool.query(
            'SELECT license_key, action, note, created_at FROM license_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 10', 
            [user.id]
        );
        
        const [invoices] = await pool.query(
            'SELECT invoice_no, amount, status, purpose, created_at, paid_at FROM invoices WHERE user_id = ? ORDER BY created_at DESC LIMIT 10', 
            [user.id]
        );

        const embed = new EmbedBuilder()
            .setTitle(`👤 User: ${user.email}`)
            .addFields(
                { name: 'ID', value: String(user.id), inline: true },
                { name: 'License Key', value: user.license_key || 'N/A', inline: true },
                { name: 'License Status', value: user.license_status || 'N/A', inline: true },
                { name: 'Website', value: user.website_url || 'N/A', inline: true },
                { name: 'Subscription Until', value: user.subscription_until ? 
                    new Date(user.subscription_until).toISOString().replace('T', ' ').split('.')[0] : 'N/A', inline: true },
                { name: 'Phone', value: user.phone || 'N/A', inline: true },
            )
            .setColor(0x57F287)
            .setFooter({ text: 'User details' });

        let histText = history.length ? 
            history.map(h => `• ${h.action} — ${h.license_key || ''} (${h.created_at.toISOString().split('T')[0]})`).join('\n') : 
            'No license history';
            
        let invText = invoices.length ? 
            invoices.map(i => `• ${i.invoice_no} — ₹${i.amount} — ${i.status} (${i.created_at.toISOString().split('T')[0]})`).join('\n') : 
            'No invoices';
            
        embed.addFields({ 
            name: 'License History (last 10)', 
            value: histText, 
            inline: false 
        });
        
        embed.addFields({ 
            name: 'Recent Invoices (last 10)', 
            value: invText, 
            inline: false 
        });

        await interaction.reply({ 
            embeds: [embed], 
            flags: [MessageFlags.Ephemeral] 
        });
    } catch (error) {
        console.error('Error in user.view:', error);
        await interaction.reply({ 
            content: '❌ Failed to fetch user details. Please try again.', 
            flags: [MessageFlags.Ephemeral] 
        });
    }
};

handlers['user.extend-sub'] = async (interaction) => {
    if (!await validateAdmin(interaction)) return;

    try {
        const email = interaction.options.getString('email');
        const months = interaction.options.getInteger('months');

        // Validate months
        if (months < 1 || months > 120) {
            return interaction.reply({ 
                content: '❌ Months must be between 1 and 120.', 
                flags: [MessageFlags.Ephemeral] 
            });
        }

        const [[user]] = await pool.query(
            'SELECT id, subscription_until FROM users WHERE email = ? LIMIT 1', 
            [email]
        );
        
        if (!user) {
            return interaction.reply({ 
                content: `❌ No user found for \`${email}\`.`, 
                flags: [MessageFlags.Ephemeral] 
            });
        }

        const now = new Date();
        let base = user.subscription_until ? new Date(user.subscription_until) : now;
        if (base < now) base = now;

        const newUntil = new Date(base);
        newUntil.setMonth(newUntil.getMonth() + months);

        await pool.query(
            'UPDATE users SET subscription_until = ? WHERE id = ?', 
            [newUntil, user.id]
        );
        
        await pool.query(
            'INSERT INTO license_history (user_id, license_key, action, note) VALUES (?, ?, ?, ?)', 
            [user.id, null, 'subscription_extended', `+${months} months until ${newUntil.toISOString().split('T')[0]}`]
        );

        await interaction.reply({ 
            content: `✅ Subscription for \`${email}\` extended by **${months} month(s)**. New expiry: **${newUntil.toISOString().split('T')[0]}**.`, 
            flags: [MessageFlags.Ephemeral] 
        });
    } catch (error) {
        console.error('Error in user.extend-sub:', error);
        await interaction.reply({ 
            content: '❌ Failed to extend subscription. Please try again.', 
            flags: [MessageFlags.Ephemeral] 
        });
    }
};

handlers['user.set-subscription'] = async (interaction) => {
    if (!await validateAdmin(interaction)) return;

    try {
        const email = interaction.options.getString('email');
        const dateString = interaction.options.getString('date');

        // Validate date format (YYYY-MM-DD)
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(dateString)) {
            return interaction.reply({ 
                content: '❌ Invalid date format. Please use YYYY-MM-DD format (e.g., 2025-12-31).', 
                flags: [MessageFlags.Ephemeral] 
            });
        }

        // Parse and validate the date
        const targetDate = new Date(dateString + 'T00:00:00.000Z');
        if (isNaN(targetDate.getTime())) {
            return interaction.reply({ 
                content: '❌ Invalid date. Please provide a valid date in YYYY-MM-DD format.', 
                flags: [MessageFlags.Ephemeral] 
            });
        }

        // Check if date is in the past
        const now = new Date();
        if (targetDate < now) {
            return interaction.reply({ 
                content: '❌ The date cannot be in the past. Please provide a future date.', 
                flags: [MessageFlags.Ephemeral] 
            });
        }

        // Find the user
        const [[user]] = await pool.query(
            'SELECT id, subscription_until FROM users WHERE email = ? LIMIT 1', 
            [email]
        );
        
        if (!user) {
            return interaction.reply({ 
                content: `❌ No user found for \`${email}\`.`, 
                flags: [MessageFlags.Ephemeral] 
            });
        }

        // Get current subscription for logging
        const currentSub = user.subscription_until ? 
            new Date(user.subscription_until).toISOString().split('T')[0] : 'None';

        // Update the subscription
        await pool.query(
            'UPDATE users SET subscription_until = ? WHERE id = ?', 
            [targetDate, user.id]
        );
        
        // Log the action
        await pool.query(
            'INSERT INTO license_history (user_id, license_key, action, note) VALUES (?, ?, ?, ?)', 
            [user.id, null, 'subscription_custom_set', `Custom subscription set from ${currentSub} to ${dateString}`]
        );

        await interaction.reply({ 
            content: `✅ Subscription for \`${email}\` has been set to **${dateString}**.\n\n*Previous subscription: ${currentSub}*`, 
            flags: [MessageFlags.Ephemeral] 
        });
    } catch (error) {
        console.error('Error in user.set-subscription:', error);
        await interaction.reply({ 
            content: '❌ Failed to set subscription. Please try again.', 
            flags: [MessageFlags.Ephemeral] 
        });
    }
};

handlers['invoice.list'] = async (interaction) => {
    if (!await validateAdmin(interaction)) return;

    try {
        const limit = Math.min(100, Math.max(1, interaction.options.getInteger('limit') || 25));
        const [rows] = await pool.query(
            'SELECT id, invoice_no, amount, status, user_id, created_at FROM invoices ORDER BY id DESC LIMIT ?', 
            [limit]
        );
        
        if (!rows.length) {
            return interaction.reply({ 
                content: 'No invoices found.', 
                flags: [MessageFlags.Ephemeral] 
            });
        }

        const embed = new EmbedBuilder()
            .setTitle(`🧾 Recent Invoices (Last ${rows.length})`)
            .setColor(0xFAA61A);
            
        const desc = rows.map(r => 
            `**${r.invoice_no}** — ₹${r.amount} — ${r.status} — UserID:${r.user_id || 'N/A'} — ${new Date(r.created_at).toISOString().split('T')[0]}`
        ).join('\n');
        
        embed.setDescription(desc);
        await interaction.reply({ 
            embeds: [embed], 
            flags: [MessageFlags.Ephemeral] 
        });
    } catch (error) {
        console.error('Error in invoice.list:', error);
        await interaction.reply({ 
            content: '❌ Failed to fetch invoices. Please try again.', 
            flags: [MessageFlags.Ephemeral] 
        });
    }
};

handlers['invoice.print'] = async (interaction) => {
    if (!await validateAdmin(interaction)) return;

    try {
        const invoice_no = interaction.options.getString('invoice_no');

        // Fetch invoice with proper error handling
        const [[invoice]] = await pool.query(
            'SELECT * FROM invoices WHERE invoice_no = ? LIMIT 1', 
            [invoice_no]
        );
        
        if (!invoice) {
            return interaction.reply({ 
                content: `❌ Invoice \`${invoice_no}\` not found.`, 
                flags: [MessageFlags.Ephemeral] 
            });
        }

        // Fetch payments associated with this invoice
        let payments = [];
        try {
            // Try to get payments from payments table first
            [payments] = await pool.query(
                'SELECT * FROM payments WHERE invoice_id = ? ORDER BY created_at ASC',
                [invoice.id]
            );

            // If no payments found but invoice is paid, create a synthetic payment record from gateway data
            if (payments.length === 0 && invoice.status === 'paid' && invoice.gateway_response) {
                try {
                    const gatewayData = JSON.parse(invoice.gateway_response);
                    if (gatewayData.result) {
                        payments = [{
                            amount: gatewayData.result.amount || invoice.amount,
                            status: 'completed',
                            gateway_provider: invoice.gateway_provider,
                            gateway_transaction_id: gatewayData.result.gateway_txn,
                            gateway_response: invoice.gateway_response,
                            created_at: invoice.paid_at,
                            paid_at: invoice.paid_at
                        }];
                    }
                } catch (e) {
                    console.error('Failed to parse gateway response:', e);
                }
            }
        } catch (error) {
            console.error('Error fetching payments:', error);
            // Continue with empty payments array
        }

        // Fetch user information
        let user = null;
        if (invoice.user_id) {
            try {
                const [[u]] = await pool.query(
                    'SELECT id, email, phone FROM users WHERE id = ? LIMIT 1', 
                    [invoice.user_id]
                );
                user = u || null;
            } catch (error) {
                console.error('Error fetching user:', error);
            }
        }

        // Reply ephemeral first (ack) then follow up with file
        await interaction.reply({ 
            content: '🖨️ Rendering invoice image — please wait...', 
            flags: [MessageFlags.Ephemeral] 
        });

        try {
            const buffer = await renderInvoicePNG(invoice, payments, user);
            const attachment = new AttachmentBuilder(buffer, { name: `invoice_${invoice_no}.png` });

            // Create an embed with invoice summary
            const embed = new EmbedBuilder()
                .setTitle(`🧾 Invoice ${invoice_no}`)
                .setColor(invoice.status === 'paid' ? 0x57F287 : invoice.status === 'pending' ? 0xFAA61A : 0xED4245)
                .addFields(
                    { name: 'Amount', value: `₹${Number(invoice.amount).toFixed(2)}`, inline: true },
                    { name: 'Status', value: invoice.status.toUpperCase(), inline: true },
                    { name: 'Purpose', value: invoice.purpose, inline: true },
                    { name: 'Created', value: new Date(invoice.created_at).toLocaleDateString(), inline: true }
                );

            if (invoice.paid_at) {
                embed.addFields({ 
                    name: 'Paid At', 
                    value: new Date(invoice.paid_at).toLocaleDateString(), 
                    inline: true 
                });
            }

            await interaction.followUp({
                content: `**Invoice ${invoice_no}**`,
                embeds: [embed],
                files: [attachment]
            });
        } catch (err) {
            console.error('render invoice failed', err);
            await interaction.followUp({
                content: '❌ Failed to render invoice image. Check bot logs.',
                flags: [MessageFlags.Ephemeral]
            });
        }
    } catch (error) {
        console.error('Error in invoice.print:', error);
        await interaction.reply({ 
            content: '❌ Failed to process invoice print request. Please try again.', 
            flags: [MessageFlags.Ephemeral] 
        });
    }
};

// -------------------------
// Component interaction handler
// -------------------------
async function handleComponentInteraction(interaction) {
    try {
        if (!(interaction.isButton() || interaction.isStringSelectMenu())) return false;

        // Security: check admin
        if (!await isAdmin(interaction)) {
            if (!interaction.replied) {
                await interaction.reply({ 
                    content: '❌ You are not allowed to run this.', 
                    ephemeral: true 
                });
            }
            return true;
        }

        // BUTTON: customId format => users_pagination|<page>|<per_page>
        if (interaction.isButton() && interaction.customId.startsWith('users_pagination|')) {
            await interaction.deferUpdate();
            const [, pageStr, perPageStr] = interaction.customId.split('|');
            const page = parseInt(pageStr, 10) || 1;
            const per_page = Math.min(50, Math.max(1, parseInt(perPageStr, 10) || 10));
            const payload = await buildUsersPagePayload(page, per_page);
            
            try {
                await interaction.editReply(payload);
            } catch (err) {
                // Fallback: try edit the underlying message if possible
                try { 
                    await interaction.message.edit(payload); 
                } catch (e) { 
                    console.error('Failed to edit message', e); 
                }
            }
            return true;
        }

        // SELECT: customId format => users_perpage|<currentPage>
        if (interaction.isStringSelectMenu() && interaction.customId.startsWith('users_perpage|')) {
            await interaction.deferUpdate();
            const [, currentPageStr] = interaction.customId.split('|');
            const selectedPerPage = parseInt(interaction.values[0], 10) || 10;
            const currentPage = parseInt(currentPageStr, 10) || 1;
            const payload = await buildUsersPagePayload(currentPage, selectedPerPage);
            
            try {
                await interaction.editReply(payload);
            } catch (err) {
                try { 
                    await interaction.message.edit(payload); 
                } catch (e) { 
                    console.error('Failed to edit message', e); 
                }
            }
            return true;
        }

        return false;
    } catch (error) {
        console.error('handleComponentInteraction error', error);
        try {
            if (!interaction.replied) {
                await interaction.reply({ 
                    content: '❌ Error processing component interaction.', 
                    ephemeral: true 
                });
            }
        } catch (e) { 
            console.error('Failed to send error response', e);
        }
        return true;
    }
}

// -------------------------
// Export
// -------------------------
module.exports = {
    commands,
    handlers,
    handleComponentInteraction,
};