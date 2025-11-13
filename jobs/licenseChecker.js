// jobs/licenseChecker.js
const { pool } = require('../config/database');
const { suspendUser } = require('../services/internalLicense');

let running = false;

async function checkAndSuspendExpired() {
  if (running) return;
  running = true;
  try {
    const [rows] = await pool.query("SELECT id, email FROM users WHERE subscription_until IS NOT NULL AND subscription_until < NOW() AND license_status != 'suspended' LIMIT 500");
    for (const u of rows) {
      try {
        await suspendUser(u.id, 'expired_by_scheduler');
        console.info(`Suspended user ${u.id} (${u.email})`);
      } catch (err) {
        console.error('suspend error for user', u.id, err);
      }
    }
  } catch (err) {
    console.error('licenseChecker error', err);
  } finally {
    running = false;
  }
}

function startScheduler() {
  const sec = parseInt(process.env.LICENSE_CHECK_INTERVAL_SECONDS || '60', 10);
  checkAndSuspendExpired();
  return setInterval(checkAndSuspendExpired, sec * 1000);
}

module.exports = { startScheduler };
