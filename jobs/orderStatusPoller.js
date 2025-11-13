// jobs/orderStatusPoller.js
const { pool } = require('../config/database');
const { checkOrderStatus } = require('../services/chargeGateway');
const { createUserFromPendingAndActivate, addDaysForUser } = require('../services/internalLicense');

let running = false;

async function pollPendingOrders() {
  if (running) return;
  running = true;
  try {
    const [rows] = await pool.query("SELECT * FROM invoices WHERE status = 'pending' AND created_at >= (NOW() - INTERVAL 6 HOUR) ORDER BY created_at ASC LIMIT 200");
    for (const invoice of rows) {
      try {
        const resp = await checkOrderStatus({ order_id: invoice.invoice_no });
        if (!resp.ok) continue;
        const body = resp.data;
        if (!body || !body.result) continue;
        const result = body.result;
        const txnStatus = (result.txnStatus || '').toUpperCase();

        if (txnStatus === 'SUCCESS') {
          const providerTxnId = result.utr || null;
          if (providerTxnId) {
            const [exists] = await pool.query('SELECT id FROM payments WHERE invoice_id = ? AND provider_transaction_id = ?', [invoice.id, providerTxnId]);
            if (exists.length === 0) {
              await pool.query('INSERT INTO payments (invoice_id, provider_transaction_id, provider_response, amount, status, created_at) VALUES (?, ?, ?, ?, ?, NOW())', [
                invoice.id, providerTxnId, JSON.stringify(body), result.amount || invoice.amount, 'success'
              ]);
            }
          } else {
            await pool.query('INSERT INTO payments (invoice_id, provider_transaction_id, provider_response, amount, status, created_at) VALUES (?, ?, ?, ?, ?, NOW())', [
              invoice.id, null, JSON.stringify(body), result.amount || invoice.amount, 'success'
            ]);
          }

          await pool.query('UPDATE invoices SET status = ?, paid_at = NOW(), gateway_response = ? WHERE id = ?', ['paid', JSON.stringify(body), invoice.id]);

          if (invoice.pending_user_id) {
            const [pRows] = await pool.query('SELECT * FROM pending_users WHERE id = ?', [invoice.pending_user_id]);
            if (pRows.length) {
              try {
                await createUserFromPendingAndActivate(pRows[0], 30);
              } catch (err) {
                console.error('create user from pending failed', err);
              }
            }
          } else if (invoice.user_id) {
            try {
              await addDaysForUser(invoice.user_id, 30);
            } catch (err) {
              console.error('renew user failed', invoice.user_id, err);
            }
          }
          continue;
        }

        if (txnStatus === 'PENDING') {
          const createdAt = new Date(invoice.created_at);
          const elapsedMin = (Date.now() - createdAt.getTime()) / (1000 * 60);
          const timeoutMin = parseInt(process.env.ORDER_TIMEOUT_MINUTES || '30', 10);
          if (elapsedMin >= timeoutMin) {
            await pool.query('UPDATE invoices SET status = ? WHERE id = ?', ['failed', invoice.id]);
            await pool.query('INSERT INTO payments (invoice_id, provider_transaction_id, provider_response, amount, status, created_at) VALUES (?, ?, ?, ?, ?, NOW())', [
              invoice.id, null, JSON.stringify(body), invoice.amount, 'failed'
            ]);
          }
          continue;
        }

        await pool.query('UPDATE invoices SET status = ?, gateway_response = ? WHERE id = ?', ['failed', JSON.stringify(body), invoice.id]);
        await pool.query('INSERT INTO payments (invoice_id, provider_transaction_id, provider_response, amount, status, created_at) VALUES (?, ?, ?, ?, ?, NOW())', [
          invoice.id, null, JSON.stringify(body), invoice.amount, 'failed'
        ]);
      } catch (innerErr) {
        console.error('error in poll loop for invoice', invoice.id, innerErr);
      }
    }
  } catch (err) {
    console.error('orderStatusPoller error', err);
  } finally {
    running = false;
  }
}

function startOrderPoller() {
  const sec = parseInt(process.env.ORDER_POLL_INTERVAL_SECONDS || '30', 10);
  pollPendingOrders();
  return setInterval(pollPendingOrders, sec * 1000);
}

module.exports = { startOrderPoller, pollPendingOrders };
