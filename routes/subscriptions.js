// routes/subscriptions.js
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const bcrypt = require('bcryptjs');
const { createOrder, checkOrderStatus } = require('../services/chargeGateway');
const { createUserFromPendingAndActivate, addDaysForUser, daysLeftForUser } = require('../services/internalLicense');

/**
 * Backend base URL used for gateway redirect callback.
 * Ensure SERVER_BASE_URL is set in .env (e.g. http://72.60.100.34:3000)
 */
const FRONTEND_BASE = process.env.SERVER_BASE_URL || 'http://localhost:3000';

function makeInvoiceNo() {
  return 'INV' + Date.now() + Math.floor(Math.random() * 900 + 100);
}

/**
 * Helper: find a recent pending invoice for given user or pending_user (30 minutes window).
 * Returns invoice row or null.
 */
async function findRecentPendingInvoice({ userId = null, pendingUserId = null, purpose = null, windowMinutes = 30 }) {
  const whereParts = ['status = "pending"'];
  const params = [];

  if (userId) {
    whereParts.push('user_id = ?');
    params.push(userId);
  }
  if (pendingUserId) {
    whereParts.push('pending_user_id = ?');
    params.push(pendingUserId);
  }
  if (purpose) {
    whereParts.push('purpose = ?');
    params.push(purpose);
  }

  // created within last windowMinutes
  const sql = `SELECT * FROM invoices WHERE ${whereParts.join(' AND ')} AND created_at >= (NOW() - INTERVAL ? MINUTE) ORDER BY created_at DESC LIMIT 1`;
  params.push(windowMinutes);

  const [rows] = await pool.query(sql, params);
  return rows.length ? rows[0] : null;
}

/**
 * POST /api/subscription/create-invoice
 * Body:
 *  - purpose: 'initial'|'renewal'
 *  - amount
 *  - userId (for renewal) OR email,password for initial
 *  - phone (optional)
 *
 * This endpoint creates an invoice record (and pending_user for initial) and returns invoice meta.
 */
router.post('/create-invoice', async (req, res) => {
  try {
    const { purpose, amount, userId, email, password, phone } = req.body;
    if (!purpose || !amount) return res.status(400).json({ error: 'purpose and amount required' });
    if (purpose === 'initial' && (!email || !password)) return res.status(400).json({ error: 'email & password required for initial' });

    let pending_user_id = null;

    if (purpose === 'initial') {
      // Create pending user
      const pwHash = await bcrypt.hash(password, 12);
      const [ins] = await pool.query(
        'INSERT INTO pending_users (email, password_hash, phone, meta, created_at) VALUES (?, ?, ?, ?, NOW())',
        [email, pwHash, phone || null, JSON.stringify({ origin: 'create-invoice' })]
      );
      pending_user_id = ins.insertId;
    }

    // Reuse recent pending invoice to avoid duplicates
    const recent = await findRecentPendingInvoice({ userId: userId || null, pendingUserId: pending_user_id, purpose, windowMinutes: 30 });
    if (recent) {
      return res.json({
        invoiceId: recent.id,
        invoice_no: recent.invoice_no,
        amount: Number(recent.amount),
        reused: true
      });
    }

    const invoice_no = makeInvoiceNo();
    const [inv] = await pool.query(
      'INSERT INTO invoices (invoice_no, user_id, pending_user_id, amount, purpose, status, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())',
      [invoice_no, userId || null, pending_user_id, parseFloat(amount), purpose, 'pending']
    );

    return res.json({ invoiceId: inv.insertId, invoice_no, amount: parseFloat(amount) });
  } catch (err) {
    console.error('create-invoice error', err);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * GET /api/subscription/pay/:invoiceId
 * Creates an order at the gateway and returns payment_url
 */
router.get('/pay/:invoiceId', async (req, res) => {
  try {
    const invoiceId = req.params.invoiceId;
    const [rows] = await pool.query('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
    if (!rows.length) return res.status(404).json({ error: 'invoice_not_found' });
    const invoice = rows[0];

    // ensure invoice still pending
    if (invoice.status !== 'pending') {
      return res.status(400).json({ error: 'invoice_not_pending', status: invoice.status });
    }

    // find phone if available
    let phone = '';
    if (invoice.pending_user_id) {
      const [prows] = await pool.query('SELECT phone FROM pending_users WHERE id = ?', [invoice.pending_user_id]);
      if (prows.length) phone = prows[0].phone || '';
    } else if (invoice.user_id) {
      const [urows] = await pool.query('SELECT phone FROM users WHERE id = ?', [invoice.user_id]);
      if (urows.length) phone = urows[0].phone || '';
    }

    // Build redirect URL (gateway will redirect browser back to this backend endpoint)
    const redirectUrlForThisOrder = `${FRONTEND_BASE.replace(/\/$/, '')}/api/subscription/redirect?invoice_no=${encodeURIComponent(invoice.invoice_no)}`;

    const createResp = await createOrder({
      amount: invoice.amount,
      customer_mobile: phone || '',
      order_id: invoice.invoice_no,
      remark1: invoice.purpose || '',
      remark2: 'invoice:' + invoice.id,
      redirect_url: redirectUrlForThisOrder
    });

    if (!createResp.ok) {
      console.error('createOrder failed', createResp);
      return res.status(502).json({ error: 'payment_provider_error', details: createResp.error });
    }

    const body = createResp.data;
    if (body && body.status === true && body.result && body.result.payment_url) {
      await pool.query('UPDATE invoices SET gateway_provider = ?, gateway_response = ? WHERE id = ?', ['charge_wamosync', JSON.stringify(body), invoice.id]);
      return res.json({ payment_url: body.result.payment_url, provider_order_id: body.result.orderId || invoice.invoice_no });
    } else {
      console.error('createOrder returned error', body);
      return res.status(502).json({ error: 'payment_create_failed', message: body && body.message });
    }
  } catch (err) {
    console.error('pay error', err);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * GET /api/subscription/redirect
 * Called by gateway via browser redirect. Returns JSON with payment verification result.
 */
// Replace your existing router.get('/redirect', ...) with this handler
router.get('/redirect', async (req, res) => {
  try {
    const invoiceNo = req.query.invoice_no || req.query.invoiceNo || null;
    if (!invoiceNo) {
      res.status(400);
      return res.send(renderRedirectPage({
        status: 'failed',
        title: 'Missing invoice',
        message: 'Missing query parameter: invoice_no',
        invoice_no: null,
      }));
    }

    const [invRows] = await pool.query('SELECT * FROM invoices WHERE invoice_no = ?', [invoiceNo]);
    if (!invRows.length) {
      res.status(404);
      return res.send(renderRedirectPage({
        status: 'failed',
        title: 'Invoice not found',
        message: `Invoice ${invoiceNo} was not found.`,
        invoice_no: invoiceNo,
      }));
    }
    const invoice = invRows[0];

    // Query provider for authoritative status
    const checkResp = await checkOrderStatus({ order_id: invoice.invoice_no });
    if (!checkResp.ok) {
      res.status(502);
      return res.send(renderRedirectPage({
        status: 'error',
        title: 'Payment provider unreachable',
        message: 'Could not reach payment provider to verify transaction.',
        invoice_no: invoice.invoice_no,
        provider_response: checkResp.data || null
      }));
    }

    const body = checkResp.data;
    if (!body || !body.result) {
      res.status(502);
      return res.send(renderRedirectPage({
        status: 'error',
        title: 'Invalid provider response',
        message: 'Payment provider returned an unexpected response shape.',
        invoice_no: invoice.invoice_no,
        provider_response: body || null
      }));
    }

    const result = body.result;
    const txnStatus = (result.txnStatus || '').toUpperCase();

    // COMMON: pretty provider JSON for display
    const providerPretty = safeJsonStringify(body);

    if (txnStatus === 'COMPLETED') {
      // idempotent: if already paid, return success page
      const [cur] = await pool.query('SELECT status FROM invoices WHERE id = ?', [invoice.id]);
      if (cur.length && cur[0].status === 'paid') {
        return res.send(renderRedirectPage({
          status: 'success',
          title: 'Already paid',
          message: 'Invoice was already marked paid previously.',
          invoice_no: invoice.invoice_no,
          amount: invoice.amount,
          provider_response: body,
        }));
      }

      // record payment (avoid duplicate payments)
      const providerTxnId = result.utr || null;
      if (providerTxnId) {
        const [exist] = await pool.query('SELECT id FROM payments WHERE invoice_id = ? AND provider_transaction_id = ?', [invoice.id, providerTxnId]);
        if (exist.length === 0) {
          await pool.query(
            'INSERT INTO payments (invoice_id, provider_transaction_id, provider_response, amount, status, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
            [invoice.id, providerTxnId, JSON.stringify(body), result.amount || invoice.amount, 'success']
          );
        }
      } else {
        await pool.query(
          'INSERT INTO payments (invoice_id, provider_transaction_id, provider_response, amount, status, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
          [invoice.id, null, JSON.stringify(body), result.amount || invoice.amount, 'success']
        );
      }

      await pool.query('UPDATE invoices SET status = ?, paid_at = NOW(), gateway_response = ? WHERE id = ?', ['paid', JSON.stringify(body), invoice.id]);

      // Activate or create user
      if (invoice.pending_user_id) {
        const [p] = await pool.query('SELECT * FROM pending_users WHERE id = ?', [invoice.pending_user_id]);
        if (p.length) {
          try {
            const pendingUser = p[0];
            const meta = JSON.parse(pendingUser.meta || '{}');
            const websiteId = meta.website_id;

            if (!websiteId) {
              console.error('No website_id found in pending user meta:', meta);
              return res.send(renderRedirectPage({
                status: 'success',
                title: 'Payment successful — user creation missing data',
                message: 'Payment recorded but pending user meta missing website_id. Admin reconciliation required.',
                invoice_no: invoice.invoice_no,
                provider_response: body
              }));
            }

            const created = await createUserFromPendingAndActivate(pendingUser, 30, websiteId);
            return res.send(renderRedirectPage({
              status: 'success',
              title: 'User created and activated',
              message: `User created and subscription activated until ${created.subscription_until}.`,
              invoice_no: invoice.invoice_no,
              userId: created.userId,
              subscription_until: created.subscription_until,
              website_id: websiteId,
              provider_response: body
            }));
          } catch (err) {
            console.error('createUserFromPendingAndActivate failed', err);
            return res.send(renderRedirectPage({
              status: 'success',
              title: 'Payment recorded — user creation failed',
              message: 'Payment was successful but automatic user creation failed. Admin action required.',
              invoice_no: invoice.invoice_no,
              provider_response: body
            }));
          }
        } else {
          return res.send(renderRedirectPage({
            status: 'success',
            title: 'Payment recorded — pending user missing',
            message: 'Payment recorded but the referenced pending_user row is missing.',
            invoice_no: invoice.invoice_no,
            provider_response: body
          }));
        }
      } else if (invoice.user_id) {
        try {
          const resultAdd = await addDaysForUser(invoice.user_id, 30);
          return res.send(renderRedirectPage({
            status: 'success',
            title: 'Subscription extended',
            message: `Subscription extended until ${resultAdd.subscription_until}`,
            invoice_no: invoice.invoice_no,
            subscription_until: resultAdd.subscription_until,
            provider_response: body
          }));
        } catch (err) {
          console.error('addDaysForUser failed', err);
          return res.send(renderRedirectPage({
            status: 'success',
            title: 'Payment processed — activation failed',
            message: 'Payment recorded but subscription activation failed. Admin reconciliation required.',
            invoice_no: invoice.invoice_no,
            provider_response: body
          }));
        }
      }

      // Generic success
      return res.send(renderRedirectPage({
        status: 'success',
        title: 'Payment processed',
        message: 'Payment was processed successfully.',
        invoice_no: invoice.invoice_no,
        amount: result.amount || invoice.amount,
        provider_response: body
      }));
    }

    if (txnStatus === 'PENDING') {
      return res.send(renderRedirectPage({
        status: 'pending',
        title: 'Payment pending',
        message: 'The payment is currently pending at the provider.',
        invoice_no: invoice.invoice_no,
        provider_response: body
      }));
    }

    // failed or unknown
    await pool.query('UPDATE invoices SET status = ?, gateway_response = ? WHERE id = ?', ['failed', JSON.stringify(body), invoice.id]);
    return res.send(renderRedirectPage({
      status: 'failed',
      title: 'Payment failed',
      message: body.message || 'Payment failed according to provider.',
      invoice_no: invoice.invoice_no,
      provider_response: body
    }));
  } catch (err) {
    console.error('redirect handler error', err);
    res.status(500);
    return res.send(renderRedirectPage({
      status: 'error',
      title: 'Server error',
      message: 'An unexpected server error occurred while processing the redirect.',
      provider_response: err?.message || null
    }));
  }
});

/**
 * Helper: safely stringify JSON for display
 */
function safeJsonStringify(obj) {
  try {
    return JSON.stringify(obj, null, 2);
  } catch (e) {
    return String(obj);
  }
}

/**
 * Helper: escape minimal html characters
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Renders a responsive single-page HTML for the redirect result.
 * Accepts an object with: status (success|failed|pending|error), title, message, invoice_no, amount, userId, subscription_until, website_id, provider_response.
 */
function renderRedirectPage({ status, title, message, invoice_no, amount, userId, subscription_until, website_id, provider_response }) {
  const colorMap = {
    success: '#16a34a',
    pending: '#f59e0b',
    failed:  '#ef4444',
    error:   '#6b7280'
  };
  const color = colorMap[status] || '#374151';
  const providerPretty = provider_response ? escapeHtml(safeJsonStringify(provider_response)) : null;

  return `
  <!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width,initial-scale=1"/>
    <title>Payment status — ${escapeHtml(title || '')}</title>
    <style>
      :root {
        --bg: #f7fafc;
        --card: #ffffff;
        --muted: #6b7280;
        --accent: ${color};
        --radius: 14px;
        --maxw: 920px;
      }
      html,body { height:100%; margin:0; font-family:Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial; background: linear-gradient(180deg, #f3f4f6 0%, var(--bg) 100%); color:#0f172a; }
      .wrap { min-height:100%; display:flex; align-items:center; justify-content:center; padding:28px; box-sizing:border-box; }
      .card { width:100%; max-width:var(--maxw); background:var(--card); border-radius:var(--radius); box-shadow:0 10px 30px rgba(2,6,23,0.08); padding:28px; box-sizing:border-box; }
      .header { display:flex; gap:18px; align-items:center; }
      .badge { width:62px; height:62px; border-radius:12px; display:grid; place-items:center; background: linear-gradient(135deg, rgba(0,0,0,0.04), rgba(0,0,0,0.02)); border: 1px solid rgba(0,0,0,0.04); }
      .dot { width:18px; height:18px; border-radius:6px; background:var(--accent); box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
      h1 { margin:0; font-size:20px; letter-spacing:-0.2px; }
      p.lead { margin:6px 0 0 0; color:var(--muted); font-size:14px; }

      .grid { display:grid; grid-template-columns: 1fr 320px; gap:20px; margin-top:20px; }
      @media (max-width:880px) { .grid { grid-template-columns: 1fr; } .sidebar { order: -1; } }

      .panel { background:#fbfdff; border-radius:10px; padding:16px; border:1px solid rgba(2,6,23,0.03); }
      .row { display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px dashed rgba(15,23,42,0.04); }
      .row:last-child { border-bottom:0; }
      .muted { color:var(--muted); font-size:13px; }
      .strong { font-weight:600; }

      .big { font-size:28px; font-weight:700; margin:6px 0 0 0; }
      .small { font-size:13px; color:var(--muted); margin-top:4px; }

      details { margin-top:12px; background:#fff; border-radius:8px; padding:12px; border:1px solid rgba(2,6,23,0.03); }
      pre { max-height:320px; overflow:auto; background:#0f172a; color:#e6eef8; padding:12px; border-radius:6px; font-size:12px; line-height:1.4; }
      .cta { display:inline-block; margin-top:12px; padding:10px 14px; border-radius:8px; text-decoration:none; background:var(--accent); color:white; font-weight:600; }
      .meta { color:var(--muted); font-size:13px; margin-top:8px; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card" role="main" aria-labelledby="title">
        <div class="header">
          <div class="badge" aria-hidden="true">
            <div class="dot" style="background:${color};"></div>
          </div>
          <div>
            <h1 id="title">${escapeHtml(title || 'Payment status')}</h1>
            <p class="lead">${escapeHtml(message || '')}</p>
            <div class="meta">Invoice: <strong>${escapeHtml(invoice_no || '—')}</strong> ${ amount ? ' • Amount: <strong>' + escapeHtml(String(amount)) + '</strong>' : '' }</div>
          </div>
        </div>

        <div class="grid">
          <div>
            <div class="panel" aria-live="polite">
              <div class="row"><div class="muted">Status</div><div class="strong">${escapeHtml(status || '')}</div></div>
              ${ userId ? `<div class="row"><div class="muted">User ID</div><div class="strong">${escapeHtml(String(userId))}</div></div>` : '' }
              ${ subscription_until ? `<div class="row"><div class="muted">Subscription until</div><div class="strong">${escapeHtml(String(subscription_until))}</div></div>` : '' }
              ${ website_id ? `<div class="row"><div class="muted">Website</div><div class="strong">${escapeHtml(String(website_id))}</div></div>` : '' }
            </div>
          </div>

          <aside class="sidebar">
            <div class="panel">
              <div class="muted">Quick summary</div>
              <div class="big" style="color:${color}">${escapeHtml(title || '')}</div>
              <div class="small">${escapeHtml(message || '')}</div>

              <hr style="margin:12px 0;border:none;border-top:1px solid rgba(2,6,23,0.04)"/>

              <div class="muted">Invoice</div>
              <div style="font-weight:600">${escapeHtml(invoice_no || '—')}</div>
              ${ amount ? `<div class="muted" style="margin-top:6px">Amount</div><div style="font-weight:600">${escapeHtml(String(amount))}</div>` : '' }
            </div>
          </aside>
        </div>

      </div>
    </div>
  </body>
  </html>
  `;
}

/**
 * GET /api/subscription/check/:invoice_no
 * Allow clients to poll the invoice status
 */
router.get('/check/:invoice_no', async (req, res) => {
  try {
    const invoiceNo = req.params.invoice_no;
    const [rows] = await pool.query('SELECT id, invoice_no, status, amount, paid_at, created_at FROM invoices WHERE invoice_no = ?', [invoiceNo]);
    if (!rows.length) return res.status(404).json({ error: 'invoice_not_found' });
    return res.json(rows[0]);
  } catch (err) {
    console.error('check invoice error', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

/**
 * GET /api/subscription/days-left  (auth required - mount with authenticate middleware)
 */
router.get('/days-left', async (req, res) => {
  try {
    const userId = req.user && req.user.id;
    if (!userId) return res.status(401).json({ error: 'unauthenticated' });
    const days = await daysLeftForUser(userId);
    const [rows] = await pool.query('SELECT subscription_until FROM users WHERE id = ?', [userId]);
    const until = rows.length ? rows[0].subscription_until : null;
    res.json({ daysLeft: days, subscription_until: until });
  } catch (err) {
    console.error('days-left err', err);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * GET /api/subscription/invoices  (auth required)
 */
router.get('/invoices', async (req, res) => {
  try {
    const userId = req.user && req.user.id;
    if (!userId) return res.status(401).json({ error: 'unauthenticated' });
    const [rows] = await pool.query('SELECT * FROM invoices WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', [userId]);
    res.json(rows);
  } catch (err) {
    console.error('invoices err', err);
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
