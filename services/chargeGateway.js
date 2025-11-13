// services/chargeGateway.js
// Adapter for Charge (wamosync) gateway - create order & check order status
const axios = require('axios');
const qs = require('qs');

const BASE = process.env.CHARGE_BASE_URL || 'https://charge.wamosync.in';
const USER_TOKEN = process.env.CHARGE_USER_TOKEN;

if (!USER_TOKEN) console.warn('CHARGE_USER_TOKEN not set; createOrder/checkOrderStatus will fail.');

async function createOrder({ amount, customer_mobile = '', order_id, remark1 = '', remark2 = '', redirect_url = '' }) {
  const url = `${BASE}/api/create-order`;
  const payload = {
    customer_mobile,
    user_token: USER_TOKEN,
    amount: String(amount),
    order_id: String(order_id),
    redirect_url: redirect_url || '',
    remark1,
    remark2
  };

  try {
    const resp = await axios.post(url, qs.stringify(payload), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000
    });
    return { ok: true, data: resp.data };
  } catch (err) {
    return { ok: false, error: err.message || String(err), raw: err.response && err.response.data };
  }
}

async function checkOrderStatus({ order_id }) {
  const url = `${BASE}/api/check-order-status`;
  const payload = { user_token: USER_TOKEN, order_id: String(order_id) };

  try {
    const resp = await axios.post(url, qs.stringify(payload), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000
    });
    return { ok: true, data: resp.data };
  } catch (err) {
    return { ok: false, error: err.message || String(err), raw: err.response && err.response.data };
  }
}

module.exports = { createOrder, checkOrderStatus };
