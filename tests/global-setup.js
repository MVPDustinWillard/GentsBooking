/**
 * Playwright global setup — runs once before the entire test suite.
 * Cleans up today's null-stylist (walk-in) bookings accumulated from
 * prior test runs so OR-25 always has available slots.
 */
const Database = require('better-sqlite3');
const path     = require('path');

module.exports = async function globalSetup() {
  const dbPath = path.join(__dirname, '..', 'data.db');
  try {
    const db = new Database(dbPath);
    const today = new Date();
    const pad   = n => String(n).padStart(2, '0');
    const dateStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    // Remove walk-in (null stylist) test bookings for today so slots are available
    const info = db.prepare(
      "DELETE FROM bookings WHERE stylist_id IS NULL AND appointment_date = ? AND customer_email LIKE '%@test.com'"
    ).run(dateStr);
    if (info.changes > 0) {
      console.log(`[setup] Cleared ${info.changes} stale walk-in test booking(s) for ${dateStr}`);
    }
    db.close();
  } catch (e) {
    console.warn('[setup] DB cleanup skipped:', e.message);
  }
};
