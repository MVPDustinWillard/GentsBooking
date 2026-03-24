// Load .env in development (ignored if not present)
try { require('dotenv').config(); } catch(_) {}

const express    = require('express');
const Database   = require('better-sqlite3');
const bcrypt     = require('bcryptjs');
const session    = require('express-session');
const multer     = require('multer');
const twilio     = require('twilio');
const path       = require('path');
const fs         = require('fs');
const cron       = require('node-cron');
const crypto     = require('crypto');
const emailCfg   = require('./email.config');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// ── Twilio SMS client ──────────────────────────────────────────────────────
const smsClient = emailCfg.sms?.enabled
  ? twilio(emailCfg.sms.accountSid, emailCfg.sms.authToken)
  : null;

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Database ───────────────────────────────────────────────────────────────
// Use /data volume on Railway (persistent), fall back to local for dev
const DATA_DIR = process.env.RAILWAY_ENVIRONMENT ? '/data' : __dirname;
if (process.env.RAILWAY_ENVIRONMENT && !fs.existsSync('/data')) fs.mkdirSync('/data', {recursive:true});
const db = new Database(path.join(DATA_DIR, 'data.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS stylists (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    bio           TEXT DEFAULT '',
    role          TEXT DEFAULT 'stylist',
    active        INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS services (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    duration_min INTEGER NOT NULL DEFAULT 30,
    price_cents  INTEGER NOT NULL,
    description  TEXT DEFAULT '',
    active       INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS bookings (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name    TEXT NOT NULL,
    customer_email   TEXT NOT NULL,
    customer_phone   TEXT DEFAULT '',
    stylist_id       INTEGER REFERENCES stylists(id),
    service_id       INTEGER NOT NULL REFERENCES services(id),
    appointment_date TEXT NOT NULL,
    appointment_time TEXT NOT NULL,
    status           TEXT DEFAULT 'pending',
    notes            TEXT DEFAULT '',
    created_at       TEXT DEFAULT (datetime('now'))
  );
`);

// ── Migrate: add photo_url column if missing ───────────────────────────────
try { db.exec("ALTER TABLE stylists ADD COLUMN photo_url TEXT DEFAULT ''"); } catch(_) {}
// ── Migrate: add is_barber flag (admin who also takes appointments) ──────────
try { db.exec("ALTER TABLE stylists ADD COLUMN is_barber INTEGER NOT NULL DEFAULT 0"); } catch(_) {}
db.prepare("UPDATE stylists SET is_barber=1 WHERE role IN ('barber','stylist') AND is_barber=0").run();

// ── Customers table ────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT UNIQUE NOT NULL,
    name       TEXT DEFAULT '',
    phone      TEXT DEFAULT '',
    notes      TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Migrate: add merged_into column if missing
try { db.exec("ALTER TABLE customers ADD COLUMN merged_into TEXT DEFAULT NULL"); } catch(_) {}
try { db.exec("ALTER TABLE customers ADD COLUMN blocked INTEGER DEFAULT 0"); } catch(_) {}
try { db.exec("ALTER TABLE customers ADD COLUMN marketing_opt_in INTEGER DEFAULT 0"); } catch(_) {}
try { db.exec("ALTER TABLE customers ADD COLUMN preferences TEXT DEFAULT ''"); } catch(_) {}
try { db.exec("ALTER TABLE customers ADD COLUMN tags TEXT DEFAULT ''"); } catch(_) {}
try { db.exec("ALTER TABLE bookings ADD COLUMN no_show_msg_sent INTEGER DEFAULT 0"); } catch(_) {}
try { db.exec("ALTER TABLE bookings ADD COLUMN cancel_token TEXT DEFAULT NULL"); } catch(_) {}
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_cancel_token ON bookings(cancel_token) WHERE cancel_token IS NOT NULL"); } catch(_) {}
// Backfill cancel tokens for existing bookings that don't have one
db.prepare("SELECT id FROM bookings WHERE cancel_token IS NULL AND status IN ('pending','confirmed')").all()
  .forEach(b => { try { db.prepare('UPDATE bookings SET cancel_token=? WHERE id=?').run(crypto.randomUUID(), b.id); } catch(_) {} });

// Reminders tracking table
db.exec(`CREATE TABLE IF NOT EXISTS reminders_sent (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id    INTEGER NOT NULL,
  reminder_type TEXT NOT NULL,
  sent_at       TEXT DEFAULT (datetime('now'))
);`);

// Barber blocked times
db.exec(`CREATE TABLE IF NOT EXISTS blocked_times (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  stylist_id  INTEGER NOT NULL REFERENCES stylists(id),
  block_date  TEXT NOT NULL,
  block_start TEXT NOT NULL,
  block_end   TEXT NOT NULL,
  reason      TEXT DEFAULT '',
  created_at  TEXT DEFAULT (datetime('now'))
);`);

// Backfill existing bookings into customers table (idempotent)
db.prepare(`
  INSERT OR IGNORE INTO customers (email, name, phone)
  SELECT customer_email, customer_name, customer_phone FROM bookings
`).run();

// ── Site content table ─────────────────────────────────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS site_content (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
// Migrate: strip HTML from hero_title if it was stored with span tags
try {
  const ht = db.prepare("SELECT value FROM site_content WHERE key='hero_title'").get();
  if (ht && ht.value.includes('<')) {
    db.prepare("UPDATE site_content SET value=? WHERE key='hero_title'")
      .run(ht.value.replace(/<[^>]+>/g, ''));
  }
} catch(_) {}
(() => {
  const ins = db.prepare('INSERT OR IGNORE INTO site_content (key,value) VALUES (?,?)');
  [
    ['hero_title',      'Welcome to Gents Barbershop'],
    ['hero_title_highlight', 'Gents'],
    ['hero_subtitle',   'Experience the timeless traditional values of an old-time barber shop with specific enhancements targeted to meet the needs of today\'s gentleman — in a friendly establishment for men and boys that consistently offers the very best in services, products and camaraderie at an affordable price.'],
    ['hero_bg_image',   '/images/gents/thumb-1.jpg'],
    ['hero_banner_image','/images/gents/hero.jpg'],
    ['hours_mon',       '10am – 6pm'],
    ['hours_tue',       '10am – 6pm'],
    ['hours_wed',       'Closed'],
    ['hours_thu',       '10am – 5pm'],
    ['hours_fri',       '10am – 6pm'],
    ['hours_sat',       '9am – 3pm'],
    ['hours_sun',       '9am – 3pm'],
    ['cancel_policy',   'We understand that life can sometimes be unpredictable! Please allow a minimum of 2 hours for any cancellations to avoid a No Show Fee (this fee will be applied to your next visit). You can cancel anytime by calling us or by email. We thank you for your understanding. — The Gents Team'],
    ['gallery_1',       '/images/gents/staff-4.jpg'],
    ['gallery_2',       '/images/gents/thumb-4.jpg'],
    ['gallery_3',       '/images/gents/thumb-3.jpg'],
    ['gallery_4',       '/images/gents/thumb-1.jpg'],
    ['service_card_1_title', 'Hair Cuts'],
    ['service_card_1_desc',  'Choose from various styles tailored for you. Classic fades, modern cuts, and everything in between — our barbers have you covered.'],
    ['service_card_1_image', '/images/gents/staff-2.jpg'],
    ['service_card_2_title', 'Beard Trims'],
    ['service_card_2_desc',  'Maintain your beard with precision trims and expert shaping. Keep your look sharp and well-groomed between visits.'],
    ['service_card_2_image', '/images/gents/staff-3.jpg'],
    ['service_card_3_title', 'Styling Services'],
    ['service_card_3_desc',  'Enhance your look with professional styling and finishing. Leave the shop looking and feeling your best every time.'],
    ['service_card_3_image', '/images/gents/staff-5.jpg'],
    ['contact_phone',   '603-601-8615'],
    ['contact_email',   'shellysgents@gmail.com'],
    ['contact_address', '893 Lafayette Road, Hampton, New Hampshire 03842'],
    ['contact_instagram','@gentsbarbershophampton'],
  ].forEach(([k,v]) => ins.run(k,v));
})();

// ── Seed ───────────────────────────────────────────────────────────────────
(() => {
  if (db.prepare('SELECT COUNT(*) as c FROM stylists').get().c === 0) {
    const ins = db.prepare('INSERT INTO stylists (name,username,password_hash,role) VALUES (?,?,?,?)');
    ins.run('Marcus','marcus', bcrypt.hashSync('marcus123',10),'barber');
    ins.run('James', 'james',  bcrypt.hashSync('james123', 10),'barber');
    ins.run('Derek', 'derek',  bcrypt.hashSync('derek123', 10),'barber');
    ins.run('Admin', 'admin',  bcrypt.hashSync('admin123', 10),'admin');
  }
  if (db.prepare('SELECT COUNT(*) as c FROM services').get().c === 0) {
    const ins = db.prepare('INSERT INTO services (name,duration_min,price_cents,description) VALUES (?,?,?,?)');
    ins.run('The Basic (Haircut and Style)',30,2500,'Classic haircut and style. Fresh cut, clean finish.');
    ins.run('Gents Special (haircut, hot towel/scalp massage)',30,3000,'Haircut plus hot towel treatment and scalp massage.');
    ins.run('Jr. Haircut (12 & under)',30,2000,'Haircut for kids 12 and under.');
    ins.run('Jr. Gents Special (haircut with hot towel/scalp massage)',30,2500,'Gents Special for kids 12 and under.');
    ins.run('Senior Haircut (65+)',30,2000,'Haircut for seniors 65+ at a discounted rate.');
  }
})();

// ── Email (Resend HTTP API) ─────────────────────────────────────────────────
const RESEND_KEY = process.env.RESEND_API_KEY || '';
if (RESEND_KEY) console.log('[email] Resend configured — emails will be sent');
else            console.log('[email] No RESEND_API_KEY — emails will be skipped');

async function sendEmail(to, subject, html, attachments) {
  if (!RESEND_KEY || process.env.DISABLE_EMAIL_SENDS === 'true' || /@(test|example)\.com$/i.test(to)) {
    console.log(`[email] (dev) Would send "${subject}" to ${to}`);
    return;
  }
  const body = { from: 'Gents Barber Shop <noreply@gentsbarbershop.com>', to: [to], subject, html };
  if (attachments?.length) {
    body.attachments = attachments.map(a => ({
      filename: a.filename,
      content:  Buffer.from(a.content).toString('base64'),
    }));
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

function fmtTimeFn(t) {
  const [h,m] = t.split(':').map(Number);
  return `${h%12||12}:${String(m).padStart(2,'0')} ${h>=12?'PM':'AM'}`;
}
function fmtDateFn(d) {
  const [y,mo,day] = d.split('-').map(Number);
  return new Date(y,mo-1,day).toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});
}

// ── ICS calendar invite builder ────────────────────────────────────────────
function buildICS(booking) {
  const [y, mo, d]   = booking.appointment_date.split('-').map(Number);
  const [h, m]       = booking.appointment_time.split(':').map(Number);
  const start        = new Date(y, mo - 1, d, h, m);
  const end          = new Date(start.getTime() + (booking.duration_min || 30) * 60000);
  const pad          = n => String(n).padStart(2, '0');
  const icsDate      = dt =>
    `${dt.getFullYear()}${pad(dt.getMonth()+1)}${pad(dt.getDate())}T${pad(dt.getHours())}${pad(dt.getMinutes())}00`;
  const now          = icsDate(new Date());
  const barber       = booking.stylist_name || 'To be assigned';
  const description  = `Booking #${booking.id}\\nService: ${booking.service_name}\\nBarber: ${barber}\\nPrice: $${(booking.price_cents/100).toFixed(0)}`;

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Gents Barber Shop//Booking//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:gents-booking-${booking.id}@gentsbarbershop.com`,
    `DTSTAMP:${now}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${booking.service_name} at Gents Barber Shop`,
    'LOCATION:893 Lafayette Road\\, Hampton\\, New Hampshire',
    `DESCRIPTION:${description}`,
    `ORGANIZER;CN=Gents Barber Shop:mailto:noreply@gentsbarbershop.com`,
    `ATTENDEE;CN=${booking.customer_name};RSVP=FALSE:mailto:${booking.customer_email}`,
    'STATUS:CONFIRMED',
    'SEQUENCE:0',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

async function sendBookingConfirmation(booking) {
  const icsContent  = buildICS(booking);
  const subject     = `Booking Confirmed — Gents Barber Shop (#${booking.id})`;
  const barber      = booking.stylist_name || 'To be assigned';
  const price       = `$${(booking.price_cents / 100).toFixed(0)}`;

  // ── Email ────────────────────────────────────────────────────────────────
  const html = `
    <div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;background:#f5f0e8">
      <div style="background:linear-gradient(135deg,#6b1212,#8B1A1A);padding:32px 28px;text-align:center;border-radius:12px 12px 0 0;border-bottom:4px solid #c9a95a">
        <div style="font-size:32px;margin-bottom:10px">✂</div>
        <h1 style="color:#fff;margin:0;font-size:24px;font-weight:700;letter-spacing:0.5px">Gents Barber Shop</h1>
        <p style="color:#e8c888;margin:6px 0 0;font-size:13px;letter-spacing:0.3px">893 Lafayette Road · Hampton, New Hampshire</p>
      </div>
      <div style="background:#fff;border:1px solid #e4ddd0;border-top:none;padding:32px 28px;border-radius:0 0 12px 12px">
        <h2 style="margin:0 0 8px;color:#1a0707;font-size:22px">You're all set, ${booking.customer_name.split(' ')[0]}! 🎉</h2>
        <p style="color:#666;margin:0 0 28px;font-size:14px;line-height:1.7;font-family:sans-serif">Your appointment is confirmed and a calendar invite is attached. We look forward to seeing you!</p>
        <div style="background:#f5f0e8;border-radius:10px;border:1px solid #e4ddd0;overflow:hidden;margin-bottom:24px">
          <div style="background:#1a0707;padding:12px 18px">
            <span style="color:#c9a95a;font-size:13px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase">✂ Appointment Details</span>
          </div>
          <table style="width:100%;border-collapse:collapse;font-size:14px;font-family:sans-serif">
            <tr><td style="padding:11px 18px;color:#888;width:40%;border-bottom:1px solid #ede8e0">Booking #</td><td style="padding:11px 18px;font-weight:700;color:#8B1A1A;border-bottom:1px solid #ede8e0">#${booking.id}</td></tr>
            <tr><td style="padding:11px 18px;color:#888;border-bottom:1px solid #ede8e0">Service</td><td style="padding:11px 18px;font-weight:600;color:#1a0707;border-bottom:1px solid #ede8e0">${booking.service_name}</td></tr>
            <tr><td style="padding:11px 18px;color:#888;border-bottom:1px solid #ede8e0">Barber</td><td style="padding:11px 18px;color:#1a0707;border-bottom:1px solid #ede8e0">${barber}</td></tr>
            <tr><td style="padding:11px 18px;color:#888;border-bottom:1px solid #ede8e0">Date</td><td style="padding:11px 18px;font-weight:600;color:#1a0707;border-bottom:1px solid #ede8e0">${fmtDateFn(booking.appointment_date)}</td></tr>
            <tr><td style="padding:11px 18px;color:#888;border-bottom:1px solid #ede8e0">Time</td><td style="padding:11px 18px;font-weight:700;color:#1a0707;border-bottom:1px solid #ede8e0">${fmtTimeFn(booking.appointment_time)}</td></tr>
            <tr><td style="padding:11px 18px;color:#888">Price</td><td style="padding:11px 18px;font-weight:800;color:#8B1A1A;font-size:16px">${price}</td></tr>
          </table>
        </div>
        ${booking.cancel_token ? `
        <div style="margin:0 0 24px;padding:18px;background:#fdf5f5;border:1px solid #e8c0c0;border-radius:10px;text-align:center">
          <p style="font-size:13px;color:#666;margin:0 0 12px;font-family:sans-serif">Need to reschedule or cancel? You can manage your booking online (2-hour notice required).</p>
          <a href="${BASE_URL}/manage-booking/${booking.cancel_token}"
             style="display:inline-block;padding:11px 28px;background:#8B1A1A;color:#fff;border-radius:8px;font-size:13px;font-weight:700;text-decoration:none;font-family:sans-serif">
            Manage My Booking →
          </a>
        </div>` : ''}
        <div style="text-align:center;padding-top:16px;border-top:1px solid #e4ddd0">
          <p style="font-size:12px;color:#aaa;margin:0;font-family:sans-serif;line-height:1.8">
            <strong style="color:#8B1A1A">Gents Barber Shop</strong><br>
            893 Lafayette Road · Hampton, New Hampshire 03842<br>
            <a href="tel:6036018615" style="color:#8B1A1A;text-decoration:none">603-601-8615</a> ·
            <a href="mailto:shellysgents@gmail.com" style="color:#8B1A1A;text-decoration:none">shellysgents@gmail.com</a>
          </p>
        </div>
      </div>
    </div>`;

  await sendEmail(booking.customer_email, subject, html, [{ filename: 'appointment.ics', content: icsContent }]);
  console.log(`[email] Sent confirmation to ${booking.customer_email}`);

  // ── SMS ──────────────────────────────────────────────────────────────────
  if (booking.customer_phone) {
    const smsBody =
      `Gents Barber Shop - Booking Confirmed!\n` +
      `Service: ${booking.service_name}\n` +
      `Barber: ${barber}\n` +
      `Date: ${fmtDateFn(booking.appointment_date)}\n` +
      `Time: ${fmtTimeFn(booking.appointment_time)}\n` +
      `Location: 893 Lafayette Rd, Hampton, NH\n` +
      `Booking #${booking.id}`;

    if (emailCfg.sms?.enabled && smsClient && process.env.DISABLE_EMAIL_SENDS !== 'true') {
      await smsClient.messages.create({
        body: smsBody,
        from: emailCfg.sms.fromNumber,
        to:   booking.customer_phone,
      });
      console.log(`[sms] Sent confirmation to ${booking.customer_phone}`);
    } else {
      console.log(`[sms] (dev) Would send SMS to ${booking.customer_phone}:\n${smsBody}`);
    }
  }
}

// ── Reminder messages ──────────────────────────────────────────────────────
async function sendReminderMessage(booking, hoursAhead) {
  const barber  = booking.stylist_name || 'your barber';
  const subject = `Reminder: Your Gents appointment is in ${hoursAhead} hour${hoursAhead>1?'s':''}`;
  const html = `
    <div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;background:#f5f0e8">
      <div style="background:linear-gradient(135deg,#6b1212,#8B1A1A);padding:28px;text-align:center;border-radius:12px 12px 0 0;border-bottom:4px solid #c9a95a">
        <div style="font-size:28px;margin-bottom:8px">✂</div>
        <h1 style="color:#fff;margin:0;font-size:22px;font-weight:700">Gents Barber Shop</h1>
        <p style="color:#e8c888;margin:5px 0 0;font-size:12px;letter-spacing:0.3px">893 Lafayette Road · Hampton, New Hampshire</p>
      </div>
      <div style="background:#fff;border:1px solid #e4ddd0;border-top:none;padding:30px 28px;border-radius:0 0 12px 12px">
        <h2 style="margin:0 0 8px;color:#1a0707;font-size:20px">⏰ Appointment Reminder</h2>
        <p style="color:#555;margin:0 0 24px;font-size:14px;line-height:1.7;font-family:sans-serif">
          Hey ${booking.customer_name.split(' ')[0]}! Just a heads up — your appointment is coming up in
          <strong style="color:#8B1A1A">${hoursAhead} hour${hoursAhead>1?'s':''}</strong>. We look forward to seeing you!
        </p>
        <div style="background:#f5f0e8;border-radius:10px;border:1px solid #e4ddd0;overflow:hidden;margin-bottom:24px">
          <div style="background:#1a0707;padding:10px 18px">
            <span style="color:#c9a95a;font-size:12px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase">Your Appointment</span>
          </div>
          <table style="width:100%;border-collapse:collapse;font-size:14px;font-family:sans-serif">
            <tr><td style="padding:10px 18px;color:#888;width:40%;border-bottom:1px solid #ede8e0">Service</td><td style="padding:10px 18px;font-weight:600;color:#1a0707;border-bottom:1px solid #ede8e0">${booking.service_name}</td></tr>
            <tr><td style="padding:10px 18px;color:#888;border-bottom:1px solid #ede8e0">Barber</td><td style="padding:10px 18px;color:#1a0707;border-bottom:1px solid #ede8e0">${barber}</td></tr>
            <tr><td style="padding:10px 18px;color:#888;border-bottom:1px solid #ede8e0">Date</td><td style="padding:10px 18px;font-weight:600;color:#1a0707;border-bottom:1px solid #ede8e0">${fmtDateFn(booking.appointment_date)}</td></tr>
            <tr><td style="padding:10px 18px;color:#888">Time</td><td style="padding:10px 18px;font-weight:800;font-size:16px;color:#8B1A1A">${fmtTimeFn(booking.appointment_time)}</td></tr>
          </table>
        </div>
        <div style="background:#fffbf0;border:1px solid #e8dcc0;border-radius:8px;padding:14px 18px;margin-bottom:20px">
          <p style="font-size:13px;color:#6b5a30;margin:0;font-family:sans-serif;line-height:1.6">
            📍 <strong>893 Lafayette Road, Hampton, NH</strong> — Easy parking available on Lafayette Road (Rt. 1).
          </p>
        </div>
        <div style="text-align:center;padding-top:16px;border-top:1px solid #e4ddd0">
          <p style="font-size:12px;color:#aaa;margin:0;font-family:sans-serif;line-height:1.8">
            Need to cancel? Please call us at <a href="tel:6036018615" style="color:#8B1A1A;text-decoration:none">603-601-8615</a><br>
            <span style="font-size:11px">Cancellations require at least 2 hours notice to avoid a no-show fee.</span>
          </p>
        </div>
      </div>
    </div>`;
  await sendEmail(booking.customer_email, subject, html);
  console.log(`[email] Sent ${hoursAhead}h reminder to ${booking.customer_email}`);
  if (booking.customer_phone) {
    const smsBody = `Gents Barber Shop: Reminder! Your ${booking.service_name} appointment is in ${hoursAhead} hour${hoursAhead>1?'s':''} at ${fmtTimeFn(booking.appointment_time)}. 893 Lafayette Rd, Hampton NH.`;
    if (emailCfg.sms?.enabled && smsClient && process.env.DISABLE_EMAIL_SENDS !== 'true') {
      await smsClient.messages.create({ body: smsBody, from: emailCfg.sms.fromNumber, to: booking.customer_phone });
      console.log(`[sms] Sent ${hoursAhead}h reminder to ${booking.customer_phone}`);
    } else {
      console.log(`[sms] (dev) Would send ${hoursAhead}h reminder SMS to ${booking.customer_phone}`);
    }
  }
}

async function sendNoShowMessage(booking) {
  const first   = booking.customer_name.split(' ')[0];
  const subject = `We missed you, ${first} — let's get you rebooked!`;
  const html = `
    <div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;background:#f5f0e8">
      <div style="background:linear-gradient(135deg,#6b1212,#8B1A1A);padding:28px;text-align:center;border-radius:12px 12px 0 0;border-bottom:4px solid #c9a95a">
        <div style="font-size:28px;margin-bottom:8px">✂</div>
        <h1 style="color:#fff;margin:0;font-size:22px;font-weight:700">Gents Barber Shop</h1>
        <p style="color:#e8c888;margin:5px 0 0;font-size:12px">893 Lafayette Road · Hampton, New Hampshire</p>
      </div>
      <div style="background:#fff;border:1px solid #e4ddd0;border-top:none;padding:30px 28px;border-radius:0 0 12px 12px">
        <h2 style="margin:0 0 8px;color:#1a0707;font-size:20px">We missed you, ${first}!</h2>
        <p style="color:#555;margin:0 0 14px;font-size:14px;line-height:1.7;font-family:sans-serif">
          It looks like you weren't able to make your appointment on <strong>${fmtDateFn(booking.appointment_date)}</strong> at <strong>${fmtTimeFn(booking.appointment_time)}</strong>.
        </p>
        <p style="color:#555;margin:0 0 28px;font-size:14px;line-height:1.7;font-family:sans-serif">
          No worries at all — life happens! We'd love to see you soon. Book a new appointment online anytime or give us a call.
        </p>
        <div style="text-align:center;margin-bottom:24px">
          <a href="${BASE_URL}/booking" style="display:inline-block;padding:13px 32px;background:#8B1A1A;color:#fff;border-radius:10px;font-size:14px;font-weight:700;text-decoration:none;font-family:sans-serif">
            Book a New Appointment →
          </a>
        </div>
        <div style="text-align:center;padding-top:16px;border-top:1px solid #e4ddd0">
          <p style="font-size:12px;color:#aaa;margin:0;font-family:sans-serif;line-height:1.8">
            <strong style="color:#8B1A1A">Gents Barber Shop</strong><br>
            893 Lafayette Road · Hampton, NH 03842<br>
            <a href="tel:6036018615" style="color:#8B1A1A;text-decoration:none">603-601-8615</a>
          </p>
        </div>
      </div>
    </div>`;
  await sendEmail(booking.customer_email, subject, html);
  console.log(`[email] Sent no-show message to ${booking.customer_email}`);
  if (booking.customer_phone) {
    const smsBody = `Hi ${first}, we missed you at Gents Barber Shop today! No worries — call us or visit our website to rebook. We'd love to see you soon!`;
    if (emailCfg.sms?.enabled && smsClient && process.env.DISABLE_EMAIL_SENDS !== 'true') {
      await smsClient.messages.create({ body: smsBody, from: emailCfg.sms.fromNumber, to: booking.customer_phone });
      console.log(`[sms] Sent no-show SMS to ${booking.customer_phone}`);
    } else {
      console.log(`[sms] (dev) Would send no-show SMS to ${booking.customer_phone}`);
    }
  }
}

// ── Reminder scheduler ─────────────────────────────────────────────────────
function checkAndSendReminders() {
  const now = new Date();
  const targets = [{ hours: 24, label: '24h' }, { hours: 2, label: '2h' }];
  for (const { hours, label } of targets) {
    // Window: appointment falls within ±8 minutes of exactly N hours from now
    const windowStart = new Date(now.getTime() + (hours * 60 - 8) * 60000);
    const windowEnd   = new Date(now.getTime() + (hours * 60 + 8) * 60000);
    const pad2        = n => String(n).padStart(2,'0');
    const toDateStr   = d => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
    const toTimeStr   = d => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    const upcoming = db.prepare(`
      SELECT b.*, s.name as stylist_name, svc.name as service_name, svc.price_cents, svc.duration_min
      FROM bookings b
      LEFT JOIN stylists s  ON b.stylist_id=s.id
      LEFT JOIN services svc ON b.service_id=svc.id
      WHERE b.status IN ('pending','confirmed')
        AND ((b.appointment_date > ? OR (b.appointment_date=? AND b.appointment_time>=?))
        AND  (b.appointment_date < ? OR (b.appointment_date=? AND b.appointment_time<=?)))
    `).all(toDateStr(windowStart), toDateStr(windowStart), toTimeStr(windowStart),
           toDateStr(windowEnd),   toDateStr(windowEnd),   toTimeStr(windowEnd));
    for (const booking of upcoming) {
      const already = db.prepare('SELECT id FROM reminders_sent WHERE booking_id=? AND reminder_type=?').get(booking.id, label);
      if (already) continue;
      sendReminderMessage(booking, hours).then(() => {
        db.prepare('INSERT INTO reminders_sent (booking_id, reminder_type) VALUES (?,?)').run(booking.id, label);
      }).catch(e => console.error(`[reminder error] booking ${booking.id}:`, e.message));
    }
  }
}

// ── Multer (photo uploads) ─────────────────────────────────────────────────
const uploadsDir = process.env.RAILWAY_ENVIRONMENT
  ? '/data/uploads'
  : path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    const id  = req.params.id || req.session.barberId;
    cb(null, `${Date.now()}-${id}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|gif|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only jpg, png, gif, and webp images are allowed'));
  },
});

// ── Time slots ─────────────────────────────────────────────────────────────
const ALL_SLOTS = [];
for (let h = 9; h < 17; h++) {
  ALL_SLOTS.push(`${String(h).padStart(2,'0')}:00`);
  ALL_SLOTS.push(`${String(h).padStart(2,'0')}:30`);
}

// ── Business Hours (0=Sun … 6=Sat) ─────────────────────────────────────────
const BUSINESS_HOURS = {
  0: { open: '09:00', close: '15:00', label: 'Sun 9 AM – 3 PM' },
  1: { open: '10:00', close: '18:00', label: 'Mon 10 AM – 6 PM' },
  2: { open: '10:00', close: '18:00', label: 'Tue 10 AM – 6 PM' },
  3: null,                                                           // Wed CLOSED
  4: { open: '10:00', close: '17:00', label: 'Thu 10 AM – 5 PM' },
  5: { open: '10:00', close: '18:00', label: 'Fri 10 AM – 6 PM' },
  6: { open: '09:00', close: '15:00', label: 'Sat 9 AM – 3 PM' },
};

// ── Page routes (before static so they take priority over index.html) ──────
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'home.html')));
app.get('/booking', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'booking.html')));
app.get('/manage-booking/:token', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'manage-booking.html')));
// ── Middleware ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));
// Serve uploaded photos from persistent volume on Railway
// Uploads use content-addressed filenames from multer — safe to cache aggressively
if (process.env.RAILWAY_ENVIRONMENT) {
  app.use('/uploads', express.static('/data/uploads', { maxAge: '7d', immutable: true }));
}
if (!process.env.SESSION_SECRET) {
  console.warn('[WARN] SESSION_SECRET env var not set — using hardcoded fallback. Set SESSION_SECRET in Railway for production!');
}
app.use(session({
  secret: process.env.SESSION_SECRET || 'gents-barber-shop-secret-2026-xK9mP3rQ',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8*60*60*1000 }
}));

const requireAuth  = (req,res,next) => req.session.barberId ? next() : res.status(401).json({error:'Not authenticated'});
const requireAdmin = (req,res,next) => {
  if (!req.session.barberId) return res.status(401).json({error:'Not authenticated'});
  if (req.session.role !== 'admin') return res.status(403).json({error:'Admins only'});
  next();
};

app.get('/barber-day', requireAuth, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'barber-day.html')));

// ── Public API ─────────────────────────────────────────────────────────────
app.get('/api/services', (_req,res) => res.json(db.prepare('SELECT * FROM services WHERE active=1').all()));

app.get('/api/barbers', (_req,res) =>
  res.json(db.prepare("SELECT id,name,bio,photo_url FROM stylists WHERE active=1 AND (role IN ('barber','stylist') OR is_barber=1)").all()));

app.get('/api/availability', (req,res) => {
  const { stylist_id, date } = req.query;
  if (!date) return res.status(400).json({error:'date required'});
  const booked = stylist_id
    ? db.prepare("SELECT appointment_time FROM bookings WHERE stylist_id=? AND appointment_date=? AND status!='cancelled'").all(stylist_id,date)
    : db.prepare("SELECT appointment_time FROM bookings WHERE appointment_date=? AND status!='cancelled'").all(date);
  const taken = new Set(booked.map(r=>r.appointment_time));
  // Also exclude slots covered by barber's blocked times
  if (stylist_id) {
    const blocks = db.prepare('SELECT block_start,block_end FROM blocked_times WHERE stylist_id=? AND block_date=?').all(stylist_id, date);
    for (const slot of ALL_SLOTS) {
      for (const blk of blocks) {
        if (slot >= blk.block_start && slot < blk.block_end) { taken.add(slot); break; }
      }
    }
  }
  const [yr, mo, dy] = date.split('-').map(Number);
  const dow = new Date(yr, mo - 1, dy).getDay();
  const bh  = BUSINESS_HOURS[dow];
  // Always return non-booked slots from ALL_SLOTS; front-end uses closed/hours for UX
  res.json({ slots: ALL_SLOTS.filter(s => !taken.has(s)), closed: !bh, hours: bh || null });
});

// Business hours
app.get('/api/business-hours', (_req, res) => res.json(BUSINESS_HOURS));

// ── Public: Manage booking by cancel token ──────────────────────────────────
app.get('/api/booking/:token', (req, res) => {
  const b = db.prepare(`
    SELECT b.id, b.customer_name, b.customer_email, b.customer_phone,
      b.appointment_date, b.appointment_time, b.status, b.notes,
      s.name as stylist_name, svc.name as service_name, svc.price_cents, svc.duration_min
    FROM bookings b
    LEFT JOIN stylists s ON b.stylist_id=s.id
    LEFT JOIN services svc ON b.service_id=svc.id
    WHERE b.cancel_token=?`).get(req.params.token);
  if (!b) return res.status(404).json({error:'Booking not found'});
  res.json(b);
});

app.post('/api/booking/:token/cancel', (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE cancel_token=?').get(req.params.token);
  if (!b) return res.status(404).json({error:'Booking not found'});
  if (!['pending','confirmed'].includes(b.status))
    return res.status(400).json({error:`This booking cannot be cancelled online (status: ${b.status}).`});
  const [yr, mo, dy] = b.appointment_date.split('-').map(Number);
  const apptMs = new Date(yr, mo - 1, dy, ...b.appointment_time.split(':').map(Number)).getTime();
  if (apptMs - Date.now() < 2 * 60 * 60 * 1000)
    return res.status(400).json({error:'Cancellations require at least 2 hours notice. Please call us at 603-601-8615.'});
  db.prepare("UPDATE bookings SET status='cancelled', cancel_token=NULL WHERE cancel_token=?").run(req.params.token);
  res.json({ok:true, message:'Your appointment has been cancelled.'});
});

// Walk-in availability: only checks null-stylist conflicts (for admin walk-in modal)
app.get('/api/admin/walkin-availability', requireAuth, (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({error:'date required'});
  const booked = db.prepare("SELECT appointment_time FROM bookings WHERE stylist_id IS NULL AND appointment_date=? AND status!='cancelled'").all(date);
  const taken = new Set(booked.map(r=>r.appointment_time));
  res.json({ slots: ALL_SLOTS.filter(s=>!taken.has(s)) });
});

app.post('/api/bookings', async (req,res) => {
  const { customer_name, customer_email, customer_phone, stylist_id, service_id, appointment_date, appointment_time, notes } = req.body;
  if (!customer_name||!customer_email||!service_id||!appointment_date||!appointment_time)
    return res.status(400).json({error:'Missing required fields'});

  // Validate service exists
  if (!db.prepare('SELECT id FROM services WHERE id=? AND active=1').get(service_id))
    return res.status(400).json({error:'Invalid or inactive service'});

  // Validate stylist exists (if provided)
  if (stylist_id && !db.prepare('SELECT id FROM stylists WHERE id=? AND active=1').get(stylist_id))
    return res.status(400).json({error:'Invalid or inactive barber'});

  // Resolve canonical email in case this address was previously merged
  const merged = db.prepare('SELECT merged_into FROM customers WHERE email=? AND merged_into IS NOT NULL').get(customer_email);
  const canonical_email = merged ? merged.merged_into : customer_email;

  // Upsert customer record early (before conflict checks) so they're always in the system
  db.prepare(`INSERT INTO customers (email, name, phone)
    VALUES (?,?,?) ON CONFLICT(email) DO UPDATE SET
    name=CASE WHEN excluded.name!='' THEN excluded.name ELSE name END,
    phone=CASE WHEN excluded.phone!='' THEN excluded.phone ELSE phone END`)
    .run(canonical_email, customer_name, customer_phone||'');

  // Check if customer is blocked from online booking
  const custRec = db.prepare('SELECT blocked FROM customers WHERE email=?').get(canonical_email);
  if (custRec?.blocked) return res.status(403).json({error:'Online booking is not available for this account. Please call us directly.'});

  const conflict = db.prepare(
    "SELECT id FROM bookings WHERE stylist_id IS ? AND appointment_date=? AND appointment_time=? AND status!='cancelled'"
  ).get(stylist_id||null, appointment_date, appointment_time);
  if (conflict) return res.status(409).json({error:'That time slot is no longer available. Please choose another.'});

  const cancelToken = crypto.randomUUID();
  const r = db.prepare(
    'INSERT INTO bookings (customer_name,customer_email,customer_phone,stylist_id,service_id,appointment_date,appointment_time,notes,cancel_token) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(customer_name, customer_email, customer_phone||'', stylist_id||null, service_id, appointment_date, appointment_time, notes||'', cancelToken);

  const booking = db.prepare(`
    SELECT b.*, s.name as stylist_name, svc.name as service_name, svc.price_cents, svc.duration_min
    FROM bookings b
    LEFT JOIN stylists s ON b.stylist_id=s.id
    LEFT JOIN services svc ON b.service_id=svc.id
    WHERE b.id=?`).get(r.lastInsertRowid);

  // Send confirmation email (non-blocking)
  sendBookingConfirmation(booking).catch(e => console.error('[email error]', e.message));

  res.status(201).json(booking);
});

// ── Auth ───────────────────────────────────────────────────────────────────
app.post('/api/auth/login', (req,res) => {
  const { username, password } = req.body;
  const s = db.prepare('SELECT * FROM stylists WHERE username=? AND active=1').get(username);
  if (!s||!bcrypt.compareSync(password, s.password_hash))
    return res.status(401).json({error:'Invalid username or password'});
  req.session.barberId   = s.id;
  req.session.barberName = s.name;
  req.session.role        = s.role;
  res.json({id:s.id, name:s.name, role:s.role});
});

app.post('/api/auth/logout', (req,res) => { req.session.destroy(); res.json({ok:true}); });

app.get('/api/auth/me', (req,res) => {
  if (!req.session.barberId) return res.status(401).json({error:'Not authenticated'});
  const s = db.prepare('SELECT photo_url FROM stylists WHERE id=?').get(req.session.barberId);
  res.json({id:req.session.barberId, name:req.session.barberName, role:req.session.role, photo_url:s?.photo_url||''});
});

// Upload own photo
app.post('/api/auth/upload-photo', requireAuth, upload.single('photo'), (req,res) => {
  if (!req.file) return res.status(400).json({error:'No file uploaded'});
  // Delete old photo if exists
  const old = db.prepare('SELECT photo_url FROM stylists WHERE id=?').get(req.session.barberId);
  if (old?.photo_url) {
    const oldPath = path.join(__dirname, 'public', old.photo_url);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  const photo_url = `/uploads/${req.file.filename}`;
  db.prepare('UPDATE stylists SET photo_url=? WHERE id=?').run(photo_url, req.session.barberId);
  res.json({photo_url});
});

// Change own password
app.post('/api/auth/change-password', requireAuth, (req,res) => {
  const { current_password, new_password } = req.body;
  if (!current_password||!new_password) return res.status(400).json({error:'Both fields required'});
  if (new_password.length < 6) return res.status(400).json({error:'New password must be at least 6 characters'});
  const s = db.prepare('SELECT * FROM stylists WHERE id=?').get(req.session.barberId);
  if (!bcrypt.compareSync(current_password, s.password_hash))
    return res.status(401).json({error:'Current password is incorrect'});
  db.prepare('UPDATE stylists SET password_hash=? WHERE id=?').run(bcrypt.hashSync(new_password,10), req.session.barberId);
  res.json({ok:true});
});

// ── Admin: Bookings ────────────────────────────────────────────────────────
app.get('/api/admin/bookings', requireAuth, (req,res) => {
  const { date, date_from, status, stylist_id } = req.query;
  let q = `
    SELECT b.*, s.name as stylist_name, svc.name as service_name, svc.price_cents, svc.duration_min
    FROM bookings b
    LEFT JOIN stylists s ON b.stylist_id=s.id
    LEFT JOIN services svc ON b.service_id=svc.id
    WHERE 1=1`;
  const p = [];
  if (stylist_id) { q+=' AND b.stylist_id=?'; p.push(stylist_id); }
  if (date)      { q+=' AND b.appointment_date=?';  p.push(date); }
  if (date_from) { q+=' AND b.appointment_date>=?'; p.push(date_from); }
  if (status)    { q+=' AND b.status=?'; p.push(status); }
  q+=' ORDER BY b.appointment_date ASC, b.appointment_time ASC';
  res.json(db.prepare(q).all(...p));
});

app.patch('/api/admin/bookings/:id', requireAdmin, async (req,res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(req.params.id);
  if (!b) return res.status(404).json({error:'Booking not found'});
  const { status, notes, stylist_id, appointment_date, appointment_time } = req.body;
  const newDate = appointment_date !== undefined ? appointment_date : b.appointment_date;
  const newTime = appointment_time !== undefined ? appointment_time : b.appointment_time;
  // Prevent conflict when reassigning barber or time
  if (stylist_id !== undefined && stylist_id) {
    const conflict = db.prepare(
      "SELECT id FROM bookings WHERE stylist_id=? AND appointment_date=? AND appointment_time=? AND status!='cancelled' AND id!=?"
    ).get(stylist_id||b.stylist_id, newDate, newTime, b.id);
    if (conflict) return res.status(409).json({error:'That barber is already booked at this time'});
  }
  const updates=[]; const p=[];
  if (status!==undefined)           { updates.push('status=?');           p.push(status); }
  if (notes!==undefined)            { updates.push('notes=?');            p.push(notes); }
  if (stylist_id!==undefined)       { updates.push('stylist_id=?');       p.push(stylist_id||null); }
  if (appointment_date!==undefined) { updates.push('appointment_date=?'); p.push(appointment_date); }
  if (appointment_time!==undefined) { updates.push('appointment_time=?'); p.push(appointment_time); }
  if (!updates.length) return res.status(400).json({error:'Nothing to update'});
  p.push(req.params.id);
  db.prepare(`UPDATE bookings SET ${updates.join(',')} WHERE id=?`).run(...p);
  // Send no-show message if status changed to no_show
  if (status === 'no_show' && b.status !== 'no_show') {
    const full = db.prepare(`SELECT b.*, s.name as stylist_name, svc.name as service_name FROM bookings b LEFT JOIN stylists s ON b.stylist_id=s.id LEFT JOIN services svc ON b.service_id=svc.id WHERE b.id=?`).get(req.params.id);
    sendNoShowMessage(full).catch(e => console.error('[no-show email error]', e.message));
  }
  res.json(db.prepare('SELECT * FROM bookings WHERE id=?').get(req.params.id));
});

// ── Admin: Barbers (account management) ───────────────────────────────────
app.get('/api/admin/barbers', requireAdmin, (_req,res) =>
  res.json(db.prepare("SELECT id,name,username,bio,role,active,photo_url,is_barber FROM stylists ORDER BY role DESC, name ASC").all()));

// Admin upload photo for any member
app.post('/api/admin/barbers/:id/photo', requireAdmin, upload.single('photo'), (req,res) => {
  if (!req.file) return res.status(400).json({error:'No file uploaded'});
  const member = db.prepare('SELECT * FROM stylists WHERE id=?').get(req.params.id);
  if (!member) return res.status(404).json({error:'Not found'});
  if (member.photo_url) {
    const oldPath = path.join(__dirname, 'public', member.photo_url);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  const photo_url = `/uploads/${req.file.filename}`;
  db.prepare('UPDATE stylists SET photo_url=? WHERE id=?').run(photo_url, req.params.id);
  res.json({photo_url});
});

app.post('/api/admin/barbers', requireAdmin, (req,res) => {
  const { name, username, password, bio, role } = req.body;
  if (!name||!username||!password) return res.status(400).json({error:'name, username and password are required'});
  if (password.length < 6) return res.status(400).json({error:'Password must be at least 6 characters'});
  const exists = db.prepare('SELECT id FROM stylists WHERE username=?').get(username);
  if (exists) return res.status(409).json({error:'Username already taken'});
  const r = db.prepare('INSERT INTO stylists (name,username,password_hash,bio,role) VALUES (?,?,?,?,?)')
    .run(name.trim(), username.trim().toLowerCase(), bcrypt.hashSync(password,10), bio||'', role||'barber');
  res.status(201).json(db.prepare('SELECT id,name,username,bio,role,active FROM stylists WHERE id=?').get(r.lastInsertRowid));
});

app.patch('/api/admin/barbers/:id', requireAdmin, (req,res) => {
  const { name, bio, role, active, new_password, is_barber } = req.body;
  const s = db.prepare('SELECT * FROM stylists WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({error:'Not found'});
  // Prevent removing the last admin
  if (role==='barber' && s.role==='admin') {
    const adminCount = db.prepare("SELECT COUNT(*) as c FROM stylists WHERE role='admin' AND active=1").get().c;
    if (adminCount <= 1) return res.status(400).json({error:'Cannot demote the last admin'});
  }
  const updates=[]; const p=[];
  if (name!==undefined)         { updates.push('name=?');          p.push(name.trim()); }
  if (bio!==undefined)          { updates.push('bio=?');           p.push(bio); }
  if (role!==undefined)         { updates.push('role=?');          p.push(role); }
  if (active!==undefined)       { updates.push('active=?');        p.push(active?1:0); }
  if (is_barber!==undefined)    { updates.push('is_barber=?');     p.push(is_barber?1:0); }
  if (new_password) {
    if (new_password.length < 6) return res.status(400).json({error:'Password must be at least 6 characters'});
    updates.push('password_hash=?'); p.push(bcrypt.hashSync(new_password,10));
  }
  if (!updates.length) return res.status(400).json({error:'Nothing to update'});
  p.push(req.params.id);
  db.prepare(`UPDATE stylists SET ${updates.join(',')} WHERE id=?`).run(...p);
  res.json(db.prepare('SELECT id,name,username,bio,role,active,is_barber FROM stylists WHERE id=?').get(req.params.id));
});

// ── Admin: Customers ───────────────────────────────────────────────────────
app.get('/api/admin/customers', requireAuth, (req,res) => {
  const { q } = req.query;
  let sql = `SELECT c.*,
    COUNT(b.id) as booking_count,
    MAX(b.appointment_date) as last_visit,
    COALESCE(SUM(CASE WHEN b.status IN ('completed','confirmed','no_show') THEN svc.price_cents ELSE 0 END),0) as total_spent
    FROM customers c
    LEFT JOIN bookings b ON b.customer_email=c.email
    LEFT JOIN services svc ON b.service_id=svc.id
    WHERE c.merged_into IS NULL`;
  const params = [];
  if (q) { sql += ` AND (c.email LIKE ? OR c.name LIKE ?)`; params.push(`%${q}%`, `%${q}%`); }
  sql += ` GROUP BY c.email ORDER BY last_visit DESC, c.created_at DESC`;
  res.json(db.prepare(sql).all(...params));
});

app.get('/api/admin/customers/:email', requireAuth, (req,res) => {
  const c = db.prepare('SELECT * FROM customers WHERE email=?').get(req.params.email);
  if (!c) return res.status(404).json({error:'Customer not found'});
  const bookings = db.prepare(`
    SELECT b.id, b.appointment_date, b.appointment_time, b.status, b.notes,
      s.name as stylist_name, svc.name as service_name, svc.price_cents
    FROM bookings b
    LEFT JOIN stylists s ON b.stylist_id=s.id
    LEFT JOIN services svc ON b.service_id=svc.id
    WHERE b.customer_email=?
    ORDER BY b.appointment_date DESC, b.appointment_time DESC`).all(req.params.email);
  res.json({...c, bookings});
});

app.patch('/api/admin/customers/:email', requireAuth, (req,res) => {
  const { notes, name, phone, preferences, tags, blocked, marketing_opt_in } = req.body;
  const c = db.prepare('SELECT * FROM customers WHERE email=?').get(req.params.email);
  if (!c) return res.status(404).json({error:'Customer not found'});
  const updates=[]; const p=[];
  if (notes!==undefined)          { updates.push('notes=?');           p.push(notes); }
  if (name!==undefined)           { updates.push('name=?');            p.push(name.trim()); }
  if (phone!==undefined)          { updates.push('phone=?');           p.push(phone.trim()); }
  if (preferences!==undefined)    { updates.push('preferences=?');     p.push(preferences); }
  if (tags!==undefined)           { updates.push('tags=?');            p.push(tags); }
  if (blocked!==undefined)        { updates.push('blocked=?');         p.push(blocked?1:0); }
  if (marketing_opt_in!==undefined){ updates.push('marketing_opt_in=?'); p.push(marketing_opt_in?1:0); }
  if (!updates.length) return res.status(400).json({error:'Nothing to update'});
  p.push(req.params.email);
  db.prepare(`UPDATE customers SET ${updates.join(',')} WHERE email=?`).run(...p);
  res.json(db.prepare('SELECT * FROM customers WHERE email=?').get(req.params.email));
});

app.post('/api/admin/customers/merge', requireAdmin, (req,res) => {
  const { keep_email, drop_email } = req.body;
  if (!keep_email || !drop_email) return res.status(400).json({error:'keep_email and drop_email required'});
  if (keep_email===drop_email) return res.status(400).json({error:'Cannot merge a customer with themselves'});
  const keep = db.prepare('SELECT * FROM customers WHERE email=?').get(keep_email);
  const drop = db.prepare('SELECT * FROM customers WHERE email=?').get(drop_email);
  if (!keep) return res.status(404).json({error:'keep_email customer not found'});
  if (!drop) return res.status(404).json({error:'drop_email customer not found'});

  const mergeNotes = [keep.notes, drop.notes].filter(Boolean).join('\n\n---\n\n');
  db.prepare('UPDATE bookings SET customer_email=? WHERE customer_email=?').run(keep_email, drop_email);
  db.prepare('UPDATE customers SET notes=? WHERE email=?').run(mergeNotes, keep_email);
  // Mark dropped record as merged (not deleted) so future bookings with old email resolve to canonical
  db.prepare('UPDATE customers SET merged_into=? WHERE email=?').run(keep_email, drop_email);
  res.json(db.prepare('SELECT * FROM customers WHERE email=?').get(keep_email));
});

// ── Admin: Revenue stats ───────────────────────────────────────────────────
app.get('/api/admin/revenue', requireAuth, (req, res) => {
  const now  = new Date();
  const pad2 = n => String(n).padStart(2,'0');
  const today = `${now.getFullYear()}-${pad2(now.getMonth()+1)}-${pad2(now.getDate())}`;
  const dayOfWeek   = now.getDay();
  const mondayOffset= dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const monday = new Date(now); monday.setDate(now.getDate() - mondayOffset);
  const weekStart  = `${monday.getFullYear()}-${pad2(monday.getMonth()+1)}-${pad2(monday.getDate())}`;
  const monthStart = `${now.getFullYear()}-${pad2(now.getMonth()+1)}-01`;
  const statuses   = "('confirmed','completed','no_show')";
  const revQ = date => db.prepare(`SELECT COALESCE(SUM(svc.price_cents),0) as revenue, COUNT(*) as count FROM bookings b JOIN services svc ON b.service_id=svc.id WHERE b.status IN ${statuses} AND b.appointment_date>=?`).get(date);
  const todayQ = db.prepare(`SELECT COALESCE(SUM(svc.price_cents),0) as revenue, COUNT(*) as count FROM bookings b JOIN services svc ON b.service_id=svc.id WHERE b.status IN ${statuses} AND b.appointment_date=?`).get(today);
  const customers  = db.prepare(`SELECT COUNT(*) as c FROM customers WHERE merged_into IS NULL`).get().c;
  const allTime    = db.prepare(`SELECT COALESCE(SUM(svc.price_cents),0) as revenue, COUNT(*) as count FROM bookings b JOIN services svc ON b.service_id=svc.id WHERE b.status IN ${statuses}`).get();
  res.json({
    today:    { revenue: todayQ.revenue,      count: todayQ.count },
    week:     { revenue: revQ(weekStart).revenue,  count: revQ(weekStart).count },
    month:    { revenue: revQ(monthStart).revenue, count: revQ(monthStart).count },
    all_time: { revenue: allTime.revenue,     count: allTime.count },
    customers,
  });
});

// ── Admin: Analytics ───────────────────────────────────────────────────────
app.get('/api/admin/analytics', requireAdmin, (req, res) => {
  const pad2 = n => String(n).padStart(2,'0');
  const now  = new Date();
  const monthStart = `${now.getFullYear()}-${pad2(now.getMonth()+1)}-01`;

  const revenueTrend = db.prepare(`
    SELECT b.appointment_date as date,
      COALESCE(SUM(svc.price_cents),0) as revenue,
      COUNT(*) as count
    FROM bookings b JOIN services svc ON b.service_id=svc.id
    WHERE b.status IN ('confirmed','completed','no_show')
      AND b.appointment_date >= date('now','-13 days')
      AND b.appointment_date <= date('now')
    GROUP BY b.appointment_date ORDER BY b.appointment_date ASC`).all();

  const servicePopularity = db.prepare(`
    SELECT svc.name, COUNT(*) as count, COALESCE(SUM(svc.price_cents),0) as revenue
    FROM bookings b JOIN services svc ON b.service_id=svc.id
    WHERE b.status IN ('confirmed','completed','no_show')
    GROUP BY b.service_id ORDER BY count DESC`).all();

  const peakHours = db.prepare(`
    SELECT SUBSTR(appointment_time,1,2) as hour, COUNT(*) as count
    FROM bookings WHERE status IN ('confirmed','completed','no_show')
    GROUP BY hour ORDER BY hour ASC`).all();

  const barberPerf = db.prepare(`
    SELECT s.id, s.name,
      COUNT(*) as appts_month,
      COALESCE(SUM(svc.price_cents),0) as revenue_month,
      SUM(CASE WHEN b.status='completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN b.status='no_show'   THEN 1 ELSE 0 END) as no_shows,
      SUM(CASE WHEN b.status='cancelled' THEN 1 ELSE 0 END) as cancelled
    FROM bookings b
    JOIN stylists s ON b.stylist_id=s.id
    JOIN services svc ON b.service_id=svc.id
    WHERE b.appointment_date >= ? AND (s.role IN ('barber','stylist') OR s.is_barber=1)
    GROUP BY s.id ORDER BY revenue_month DESC`).all(monthStart);

  const statusBreakdown = db.prepare(`
    SELECT status, COUNT(*) as count FROM bookings GROUP BY status ORDER BY count DESC`).all();

  res.json({ revenueTrend, servicePopularity, peakHours, barberPerf, statusBreakdown });
});

// ── Admin: Services management ─────────────────────────────────────────────
app.get('/api/admin/services', requireAdmin, (_req, res) =>
  res.json(db.prepare('SELECT * FROM services ORDER BY active DESC, id ASC').all()));

app.post('/api/admin/services', requireAdmin, (req, res) => {
  const { name, duration_min, price_cents, description } = req.body;
  if (!name||!price_cents) return res.status(400).json({error:'name and price_cents required'});
  const r = db.prepare('INSERT INTO services (name,duration_min,price_cents,description) VALUES (?,?,?,?)')
    .run(name.trim(), duration_min||30, price_cents, description||'');
  res.status(201).json(db.prepare('SELECT * FROM services WHERE id=?').get(r.lastInsertRowid));
});

app.patch('/api/admin/services/:id', requireAdmin, (req, res) => {
  const svc = db.prepare('SELECT * FROM services WHERE id=?').get(req.params.id);
  if (!svc) return res.status(404).json({error:'Service not found'});
  const { name, duration_min, price_cents, description, active } = req.body;
  const updates=[]; const p=[];
  if (name!==undefined)         { updates.push('name=?');         p.push(name.trim()); }
  if (duration_min!==undefined) { updates.push('duration_min=?'); p.push(Number(duration_min)); }
  if (price_cents!==undefined)  { updates.push('price_cents=?');  p.push(Number(price_cents)); }
  if (description!==undefined)  { updates.push('description=?');  p.push(description); }
  if (active!==undefined)       { updates.push('active=?');       p.push(active?1:0); }
  if (!updates.length) return res.status(400).json({error:'Nothing to update'});
  p.push(req.params.id);
  db.prepare(`UPDATE services SET ${updates.join(',')} WHERE id=?`).run(...p);
  res.json(db.prepare('SELECT * FROM services WHERE id=?').get(req.params.id));
});

// ── Admin: Create booking (walk-in) ────────────────────────────────────────
app.post('/api/admin/bookings/create', requireAuth, async (req, res) => {
  const { customer_name, customer_email, customer_phone, stylist_id, service_id, appointment_date, appointment_time, notes } = req.body;
  if (!customer_name||!customer_email||!service_id||!appointment_date||!appointment_time)
    return res.status(400).json({error:'Missing required fields'});
  if (!db.prepare('SELECT id FROM services WHERE id=? AND active=1').get(service_id))
    return res.status(400).json({error:'Invalid or inactive service'});
  if (stylist_id && !db.prepare('SELECT id FROM stylists WHERE id=? AND active=1').get(stylist_id))
    return res.status(400).json({error:'Invalid barber'});
  const conflict = db.prepare("SELECT id FROM bookings WHERE stylist_id IS ? AND appointment_date=? AND appointment_time=? AND status!='cancelled'")
    .get(stylist_id||null, appointment_date, appointment_time);
  if (conflict) return res.status(409).json({error:'That time slot is already booked'});
  const cancelToken = crypto.randomUUID();
  const r = db.prepare('INSERT INTO bookings (customer_name,customer_email,customer_phone,stylist_id,service_id,appointment_date,appointment_time,notes,status,cancel_token) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(customer_name, customer_email, customer_phone||'', stylist_id||null, service_id, appointment_date, appointment_time, notes||'', 'confirmed', cancelToken);
  db.prepare(`INSERT INTO customers (email,name,phone) VALUES (?,?,?) ON CONFLICT(email) DO UPDATE SET name=CASE WHEN excluded.name!='' THEN excluded.name ELSE name END, phone=CASE WHEN excluded.phone!='' THEN excluded.phone ELSE phone END`)
    .run(customer_email, customer_name, customer_phone||'');
  const booking = db.prepare(`SELECT b.*, s.name as stylist_name, svc.name as service_name, svc.price_cents, svc.duration_min FROM bookings b LEFT JOIN stylists s ON b.stylist_id=s.id LEFT JOIN services svc ON b.service_id=svc.id WHERE b.id=?`).get(r.lastInsertRowid);
  sendBookingConfirmation(booking).catch(e => console.error('[walkin email]', e.message));
  res.status(201).json(booking);
});

// ── Admin: CSV export ──────────────────────────────────────────────────────
app.get('/api/admin/bookings/export', requireAdmin, (req, res) => {
  const bookings = db.prepare(`
    SELECT b.id, b.customer_name, b.customer_email, b.customer_phone,
      svc.name as service_name, s.name as stylist_name,
      b.appointment_date, b.appointment_time, b.status,
      svc.price_cents, b.notes, b.created_at
    FROM bookings b
    LEFT JOIN stylists s   ON b.stylist_id=s.id
    LEFT JOIN services svc ON b.service_id=svc.id
    ORDER BY b.appointment_date DESC, b.appointment_time DESC`).all();
  const q = v => `"${String(v||'').replace(/"/g,'""')}"`;
  const rows = [
    'ID,Customer Name,Email,Phone,Service,Barber,Date,Time,Status,Price ($),Notes,Booked At',
    ...bookings.map(b => [
      b.id, q(b.customer_name), q(b.customer_email), q(b.customer_phone),
      q(b.service_name), q(b.stylist_name||'Unassigned'),
      b.appointment_date, b.appointment_time, b.status,
      b.price_cents ? (b.price_cents/100).toFixed(2) : '0',
      q(b.notes), q(b.created_at)
    ].join(','))
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="gents-bookings-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send('\ufeff' + rows);
});

// ── Barber: Blocked times (self-service) ───────────────────────────────────
app.get('/api/barber/blocked-times', requireAuth, (req,res) => {
  const { date } = req.query;
  let sql = 'SELECT * FROM blocked_times WHERE stylist_id=?';
  const p = [req.session.barberId];
  if (date) { sql += ' AND block_date=?'; p.push(date); }
  sql += ' ORDER BY block_date ASC, block_start ASC';
  res.json(db.prepare(sql).all(...p));
});

app.post('/api/barber/blocked-times', requireAuth, (req,res) => {
  const { block_date, block_start, block_end, reason } = req.body;
  if (!block_date||!block_start||!block_end) return res.status(400).json({error:'block_date, block_start, block_end required'});
  if (block_start >= block_end) return res.status(400).json({error:'block_start must be before block_end'});
  const r = db.prepare('INSERT INTO blocked_times (stylist_id,block_date,block_start,block_end,reason) VALUES (?,?,?,?,?)')
    .run(req.session.barberId, block_date, block_start, block_end, reason||'');
  res.status(201).json(db.prepare('SELECT * FROM blocked_times WHERE id=?').get(r.lastInsertRowid));
});

app.delete('/api/barber/blocked-times/:id', requireAuth, (req,res) => {
  const bt = db.prepare('SELECT * FROM blocked_times WHERE id=?').get(req.params.id);
  if (!bt) return res.status(404).json({error:'Not found'});
  if (bt.stylist_id !== req.session.barberId && req.session.role !== 'admin')
    return res.status(403).json({error:'Forbidden'});
  db.prepare('DELETE FROM blocked_times WHERE id=?').run(req.params.id);
  res.json({ok:true});
});

// Admin: view all blocked times
app.get('/api/admin/blocked-times', requireAdmin, (req,res) => {
  const { stylist_id, date } = req.query;
  let sql = 'SELECT bt.*, s.name as barber_name FROM blocked_times bt JOIN stylists s ON bt.stylist_id=s.id WHERE 1=1';
  const p = [];
  if (stylist_id) { sql += ' AND bt.stylist_id=?'; p.push(stylist_id); }
  if (date)       { sql += ' AND bt.block_date=?';  p.push(date); }
  sql += ' ORDER BY bt.block_date ASC, bt.block_start ASC';
  res.json(db.prepare(sql).all(...p));
});

// Admin: delete any blocked time
app.delete('/api/admin/blocked-times/:id', requireAdmin, (req,res) => {
  const bt = db.prepare('SELECT * FROM blocked_times WHERE id=?').get(req.params.id);
  if (!bt) return res.status(404).json({error:'Not found'});
  db.prepare('DELETE FROM blocked_times WHERE id=?').run(req.params.id);
  res.json({ok:true});
});

// Admin: create blocked time for any barber
app.post('/api/admin/blocked-times', requireAdmin, (req,res) => {
  const { stylist_id, block_date, block_start, block_end, reason } = req.body;
  if (!stylist_id||!block_date||!block_start||!block_end)
    return res.status(400).json({error:'stylist_id, block_date, block_start, block_end required'});
  if (block_start >= block_end) return res.status(400).json({error:'block_start must be before block_end'});
  const r = db.prepare('INSERT INTO blocked_times (stylist_id,block_date,block_start,block_end,reason) VALUES (?,?,?,?,?)')
    .run(stylist_id, block_date, block_start, block_end, reason||'');
  res.status(201).json(
    db.prepare('SELECT bt.*, s.name as barber_name FROM blocked_times bt JOIN stylists s ON bt.stylist_id=s.id WHERE bt.id=?').get(r.lastInsertRowid)
  );
});

// Admin: Schedule view
app.get('/api/admin/schedule', requireAuth, (req,res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({error:'date required'});
  const barbers  = db.prepare("SELECT id,name,photo_url FROM stylists WHERE active=1 AND (role IN ('barber','stylist') OR is_barber=1) ORDER BY name").all();
  const bookings = db.prepare(`
    SELECT b.*, s.name as stylist_name, svc.name as service_name, svc.price_cents, svc.duration_min
    FROM bookings b
    LEFT JOIN stylists s   ON b.stylist_id=s.id
    LEFT JOIN services svc ON b.service_id=svc.id
    WHERE b.appointment_date=? AND b.status!='cancelled'
    ORDER BY b.appointment_time ASC`).all(date);
  const blocks = db.prepare('SELECT bt.*, s.name as barber_name FROM blocked_times bt JOIN stylists s ON bt.stylist_id=s.id WHERE bt.block_date=?').all(date);
  res.json({ barbers, bookings, blocks, date });
});

// Admin: customer opt-in broadcast
app.post('/api/admin/customers/broadcast', requireAdmin, async (req,res) => {
  const { message, subject, opt_in_only } = req.body;
  if (!message) return res.status(400).json({error:'message required'});
  let sql = 'SELECT * FROM customers WHERE merged_into IS NULL AND email IS NOT NULL AND email != \'\'';
  if (opt_in_only) sql += ' AND marketing_opt_in=1';
  const targets = db.prepare(sql).all();
  let sent = 0, errors = 0;
  for (const c of targets) {
    try {
      if (c.email) {
        await sendEmail(c.email, subject || 'Message from Gents Barber Shop',
          `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:24px;background:#fff;border-radius:8px">${message.replace(/\n/g,'<br>')}<p style="margin-top:24px;font-size:12px;color:#aaa">Gents Barber Shop · 893 Lafayette Road, Hampton, NH</p></div>`);
      }
      if (c.phone && emailCfg.sms?.enabled && smsClient && process.env.DISABLE_EMAIL_SENDS !== 'true' && !/@(test|example)\.com$/i.test(c.email||'')) {
        await smsClient.messages.create({ body: message, from: emailCfg.sms.fromNumber, to: c.phone });
      }
      sent++;
    } catch(e) { errors++; console.error('[broadcast error]', e.message); }
  }
  res.json({ sent, errors, total: targets.length });
});

// ── Admin: Send reminder manually ──────────────────────────────────────────
app.post('/api/admin/bookings/:id/remind', requireAdmin, async (req,res) => {
  const booking = db.prepare(`
    SELECT b.*, s.name as stylist_name, svc.name as service_name, svc.price_cents, svc.duration_min
    FROM bookings b
    LEFT JOIN stylists s   ON b.stylist_id=s.id
    LEFT JOIN services svc ON b.service_id=svc.id
    WHERE b.id=?`).get(req.params.id);
  if (!booking) return res.status(404).json({error:'Booking not found'});
  await sendReminderMessage(booking, 24).catch(e => console.error('[remind error]', e.message));
  res.json({ok:true});
});

// ── Cron: reminder scheduler ────────────────────────────────────────────────
cron.schedule('*/15 * * * *', () => {
  checkAndSendReminders();
});

// ── Site Content API ────────────────────────────────────────────────────────
app.get('/api/site-content', (_req, res) => {
  const rows = db.prepare('SELECT key, value FROM site_content').all();
  const obj = {};
  rows.forEach(r => { obj[r.key] = r.value; });
  res.json(obj);
});

app.put('/api/admin/site-content', requireAdmin, (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object') return res.status(400).json({error:'JSON object required'});
  const upd = db.prepare('INSERT OR REPLACE INTO site_content (key,value) VALUES (?,?)');
  const tx = db.transaction((obj) => {
    for (const [k,v] of Object.entries(obj)) {
      if (typeof v === 'string') upd.run(k, v);
    }
  });
  tx(updates);
  res.json({ok:true});
});

app.post('/api/admin/site-content/upload/:key', requireAdmin, upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({error:'No file uploaded'});
  const url = `/uploads/${req.file.filename}`;
  db.prepare('INSERT OR REPLACE INTO site_content (key,value) VALUES (?,?)').run(req.params.key, url);
  res.json({ok:true, url});
});

// ── Robots.txt ─────────────────────────────────────────────────────────────
app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send(
    'User-agent: *\nAllow: /\nDisallow: /admin.html\nDisallow: /api/\nSitemap: https://gentsbarbershop.com/sitemap.xml'
  );
});

// ── Sitemap.xml ────────────────────────────────────────────────────────────
app.get('/sitemap.xml', (_req, res) => {
  const base = 'https://gentsbarbershop.com';
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${base}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
  <url><loc>${base}/booking</loc><changefreq>monthly</changefreq><priority>0.9</priority></url>
</urlset>`);
});

// ── 404 handler ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Page Not Found — Gents Barber Shop</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#1a0707;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    .card{background:#fff;border-radius:16px;padding:48px 40px;max-width:480px;width:100%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.5)}
    .icon{font-size:56px;margin-bottom:16px}
    h1{font-family:Georgia,serif;font-size:28px;font-weight:700;color:#1a0707;margin-bottom:8px}
    p{font-size:15px;color:#666;line-height:1.7;margin-bottom:28px}
    .btn{display:inline-block;background:#8B1A1A;color:#fff;padding:12px 28px;border-radius:10px;font-size:15px;font-weight:700;text-decoration:none;margin:0 6px 10px;transition:background .15s}
    .btn:hover{background:#6b1212}
    .btn-ghost{background:#f5f0e8;color:#8B1A1A}
    .btn-ghost:hover{background:#e8ddd0}
    .divider{width:40px;height:3px;background:#c9a95a;border-radius:2px;margin:0 auto 24px}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✂</div>
    <h1>Page Not Found</h1>
    <div class="divider"></div>
    <p>Looks like this page got a trim! The page you're looking for doesn't exist or may have moved.</p>
    <div>
      <a href="/" class="btn">← Back to Home</a>
      <a href="/booking" class="btn btn-ghost">Book an Appointment</a>
    </div>
  </div>
</body>
</html>`);
});

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✂  Gents Barber Shop — http://localhost:${PORT}`);
  console.log(emailCfg.enabled ? '[email] SMTP configured — emails will be sent' : '[email] Dev mode — emails logged to console only');
  console.log('\nDefault logins: marcus/marcus123  james/james123  derek/derek123  admin/admin123\n');
});
