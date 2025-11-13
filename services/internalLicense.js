// services/internalLicense.js
// Minimal internal license management (monthly subscriptions)
const { pool } = require('../config/database'); // matches existing codebase
const crypto = require('crypto');

function generateLicenseKey() {
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `WMS-${random}-${Date.now().toString().slice(-4)}`;
}

/**
 * Add N days (default 30) to user's subscription_until and set license active.
 * Returns { subscription_until: Date, licenseKey }
 */
async function addDaysForUser(userId, days = 30) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT subscription_until, license_key FROM users WHERE id = ? FOR UPDATE', [userId]);
    if (!rows || rows.length === 0) throw new Error('user_not_found');
    const user = rows[0];
    const now = new Date();
    let base = now;
    if (user.subscription_until && new Date(user.subscription_until) > now) base = new Date(user.subscription_until);

    const newUntil = new Date(base.getTime() + days * 24 * 3600 * 1000);
    const licenseKey = user.license_key || generateLicenseKey();

    await conn.query('UPDATE users SET subscription_until = ?, license_status = ?, license_key = ?, updated_at = NOW() WHERE id = ?', [
      newUntil.toISOString().slice(0,19).replace('T',' '),
      'active',
      licenseKey,
      userId
    ]);

    await conn.query('INSERT INTO license_history (user_id, license_key, action, note, created_at) VALUES (?, ?, ?, ?, NOW())', [
      userId, licenseKey, 'renewed', `Added ${days} days`
    ]);

    await conn.commit();
    return { subscription_until: newUntil, licenseKey };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Create a new user from pending_users row and activate for days (30 default).
 * pendingRow is object from pending_users table.
 */
async function createUserFromPendingAndActivate(pendingUser, durationDays = 30) {
  // Parse meta to get website_id
  const meta = JSON.parse(pendingUser.meta);
  const websiteId = meta.website_id;
  
  if (!websiteId) {
    throw new Error('No website_id found in pending user meta');
  }

  const licenseKey = generateLicenseKey();
  const subscriptionUntil = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);

  console.log('Creating user with website_id:', websiteId, 'for email:', pendingUser.email);

  const [userRes] = await pool.query(`
    INSERT INTO users (email, password_hash, phone, website_id, license_key, license_status, subscription_until, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
  `, [
    pendingUser.email,
    pendingUser.password_hash,
    pendingUser.phone || null,
    websiteId,  // ← CRITICAL: Add website_id here
    licenseKey,
    'active',
    subscriptionUntil
  ]);

  // Record history
  await pool.query(
    'INSERT INTO license_history (user_id, license_key, action, note, created_at) VALUES (?, ?, ?, ?, NOW())',
    [userRes.insertId, licenseKey, 'created', 'Initial license created on activation']
  );

  // Update invoice with user_id and clear pending_user_id
  await pool.query('UPDATE invoices SET user_id = ?, pending_user_id = NULL WHERE pending_user_id = ?', [userRes.insertId, pendingUser.id]);

  // Delete pending user after migration
  await pool.query('DELETE FROM pending_users WHERE id = ?', [pendingUser.id]);

  return {
    userId: userRes.insertId,
    licenseKey,
    subscription_until: subscriptionUntil
  };
}

async function suspendUser(userId, reason = 'expired') {
  await pool.query('UPDATE users SET license_status = ? WHERE id = ?', ['suspended', userId]);
  await pool.query('INSERT INTO license_history (user_id, action, note, created_at) VALUES (?, ?, ?, NOW())', [userId, 'suspended', reason]);
}

async function daysLeftForUser(userId) {
  const [rows] = await pool.query('SELECT subscription_until FROM users WHERE id = ?', [userId]);
  if (!rows || rows.length === 0) return null;
  const until = rows[0].subscription_until;
  if (!until) return null;
  const now = new Date();
  const diffDays = Math.ceil((new Date(until) - now) / (1000 * 60 * 60 * 24));
  return diffDays;
}

module.exports = { addDaysForUser, createUserFromPendingAndActivate, suspendUser, daysLeftForUser, generateLicenseKey };