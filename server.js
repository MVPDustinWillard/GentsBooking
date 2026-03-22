const express    = require('express');
const Database   = require('better-sqlite3');
const bcrypt     = require('bcryptjs');
const session    = require('express-session');
const nodemailer = require('nodemailer');
const multer     = require('multer');
const twilio     = require('twilio');
const path       = require('path');
const fs         = require('fs');
const cron       = require('node-cron');
const emailCfg   = require('./email.config');

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

// ── Email ──────────────────────────────────────────────────────────────────
const transporter = emailCfg.enabled
  ? nodemailer.createTransport(emailCfg.smtp)
  : null;

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
    <div style="font-family:sans-serif;max-width:500px;margin:0 auto">
      <div style="background:#222;padding:24px;text-align:center;border-radius:8px 8px 0 0">
        <h1 style="color:#fff;margin:0;font-size:22px">✂ Gents Barber Shop</h1>
        <p style="color:#aaa;margin:6px 0 0;font-size:13px">893 Lafayette Road, Hampton, NH</p>
      </div>
      <div style="background:#fff;border:1px solid #e4e4e4;border-top:none;padding:28px;border-radius:0 0 8px 8px">
        <h2 style="margin:0 0 6px;color:#1a1a1a">You're booked, ${booking.customer_name.split(' ')[0]}!</h2>
        <p style="color:#666;margin:0 0 24px;font-size:14px">Your appointment is confirmed. A calendar invite is attached — see you soon!</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr><td style="padding:8px 0;color:#888;width:40%">Booking #</td><td style="padding:8px 0;font-weight:700">#${booking.id}</td></tr>
          <tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#888">Service</td><td style="padding:8px 0;font-weight:600">${booking.service_name}</td></tr>
          <tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#888">Barber</td><td style="padding:8px 0">${barber}</td></tr>
          <tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#888">Date</td><td style="padding:8px 0">${fmtDateFn(booking.appointment_date)}</td></tr>
          <tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#888">Time</td><td style="padding:8px 0">${fmtTimeFn(booking.appointment_time)}</td></tr>
          <tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#888">Price</td><td style="padding:8px 0;font-weight:700">${price}</td></tr>
        </table>
        <p style="margin:24px 0 0;font-size:13px;color:#888">To reschedule or cancel, please call us directly.<br>893 Lafayette Road, Hampton, New Hampshire</p>
      </div>
    </div>`;

  if (emailCfg.enabled && transporter) {
    await transporter.sendMail({
      from: emailCfg.from,
      to: booking.customer_email,
      subject,
      html,
      attachments: [{
        filename: 'appointment.ics',
        content:  icsContent,
        contentType: 'text/calendar; charset=utf-8; method=REQUEST',
      }],
    });
    console.log(`[email] Sent confirmation + calendar invite to ${booking.customer_email}`);
  } else {
    console.log(`[email] (dev) Would send confirmation to ${booking.customer_email} with .ics attachment`);
  }

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

    if (emailCfg.sms?.enabled && smsClient) {
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
  const subject = `Reminder: Your appointment at Gents Barber Shop`;
  const html = `
    <div style="font-family:sans-serif;max-width:500px;margin:0 auto">
      <div style="background:#222;padding:24px;text-align:center;border-radius:8px 8px 0 0">
        <h1 style="color:#fff;margin:0;font-size:22px">✂ Gents Barber Shop</h1>
        <p style="color:#aaa;margin:6px 0 0;font-size:13px">893 Lafayette Road, Hampton, NH</p>
      </div>
      <div style="background:#fff;border:1px solid #e4e4e4;border-top:none;padding:28px;border-radius:0 0 8px 8px">
        <h2 style="margin:0 0 6px;color:#1a1a1a">Appointment Reminder</h2>
        <p style="color:#666;margin:0 0 24px;font-size:14px">Your appointment is coming up in <strong>${hoursAhead} hour${hoursAhead>1?'s':''}</strong>. We look forward to seeing you!</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr><td style="padding:8px 0;color:#888;width:40%">Service</td><td style="padding:8px 0;font-weight:600">${booking.service_name}</td></tr>
          <tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#888">Barber</td><td style="padding:8px 0">${barber}</td></tr>
          <tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#888">Date</td><td style="padding:8px 0">${fmtDateFn(booking.appointment_date)}</td></tr>
          <tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#888">Time</td><td style="padding:8px 0;font-weight:700">${fmtTimeFn(booking.appointment_time)}</td></tr>
        </table>
        <p style="margin:24px 0 0;font-size:13px;color:#888">To cancel please call us at your earliest convenience.<br>893 Lafayette Road, Hampton, New Hampshire</p>
      </div>
    </div>`;
  if (emailCfg.enabled && transporter) {
    await transporter.sendMail({ from: emailCfg.from, to: booking.customer_email, subject, html });
    console.log(`[email] Sent ${hoursAhead}h reminder to ${booking.customer_email}`);
  } else {
    console.log(`[email] (dev) Would send ${hoursAhead}h reminder to ${booking.customer_email}`);
  }
  if (booking.customer_phone) {
    const smsBody = `Gents Barber Shop: Reminder! Your ${booking.service_name} appointment is in ${hoursAhead} hour${hoursAhead>1?'s':''} at ${fmtTimeFn(booking.appointment_time)}. 893 Lafayette Rd, Hampton NH.`;
    if (emailCfg.sms?.enabled && smsClient) {
      await smsClient.messages.create({ body: smsBody, from: emailCfg.sms.fromNumber, to: booking.customer_phone });
      console.log(`[sms] Sent ${hoursAhead}h reminder to ${booking.customer_phone}`);
    } else {
      console.log(`[sms] (dev) Would send ${hoursAhead}h reminder SMS to ${booking.customer_phone}`);
    }
  }
}

async function sendNoShowMessage(booking) {
  const first   = booking.customer_name.split(' ')[0];
  const subject = `We missed you at Gents Barber Shop`;
  const html = `
    <div style="font-family:sans-serif;max-width:500px;margin:0 auto">
      <div style="background:#222;padding:24px;text-align:center;border-radius:8px 8px 0 0">
        <h1 style="color:#fff;margin:0;font-size:22px">✂ Gents Barber Shop</h1>
        <p style="color:#aaa;margin:6px 0 0;font-size:13px">893 Lafayette Road, Hampton, NH</p>
      </div>
      <div style="background:#fff;border:1px solid #e4e4e4;border-top:none;padding:28px;border-radius:0 0 8px 8px">
        <h2 style="margin:0 0 6px;color:#1a1a1a">We missed you, ${first}!</h2>
        <p style="color:#666;margin:0 0 16px;font-size:14px">It looks like you weren't able to make your appointment on ${fmtDateFn(booking.appointment_date)} at ${fmtTimeFn(booking.appointment_time)}.</p>
        <p style="color:#666;margin:0 0 24px;font-size:14px">No worries — we'd love to get you back in the chair soon. Give us a call or book online to reschedule anytime.</p>
        <p style="margin:24px 0 0;font-size:13px;color:#888">893 Lafayette Road, Hampton, New Hampshire</p>
      </div>
    </div>`;
  if (emailCfg.enabled && transporter) {
    await transporter.sendMail({ from: emailCfg.from, to: booking.customer_email, subject, html });
    console.log(`[email] Sent no-show message to ${booking.customer_email}`);
  } else {
    console.log(`[email] (dev) Would send no-show message to ${booking.customer_email}`);
  }
  if (booking.customer_phone) {
    const smsBody = `Hi ${first}, we missed you at Gents Barber Shop today! No worries — call us or visit our website to rebook. We'd love to see you soon!`;
    if (emailCfg.sms?.enabled && smsClient) {
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

// ── Page routes (before static so they take priority over index.html) ──────
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'home.html')));
app.get('/booking', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'booking.html')));

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// Serve uploaded photos from persistent volume on Railway
if (process.env.RAILWAY_ENVIRONMENT) {
  app.use('/uploads', express.static('/data/uploads'));
}
app.use(session({
  secret: 'gents-barber-shop-secret-2024',
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

// ── Public API ─────────────────────────────────────────────────────────────
app.get('/api/services', (_req,res) => res.json(db.prepare('SELECT * FROM services WHERE active=1').all()));

app.get('/api/barbers', (_req,res) =>
  res.json(db.prepare("SELECT id,name,bio,photo_url FROM stylists WHERE active=1 AND role IN ('barber','stylist')").all()));

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
  res.json({ slots: ALL_SLOTS.filter(s=>!taken.has(s)) });
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

  // Check if customer is blocked from online booking
  const custRec = db.prepare('SELECT blocked FROM customers WHERE email=?').get(customer_email);
  if (custRec?.blocked) return res.status(403).json({error:'Online booking is not available for this account. Please call us directly.'});

  const conflict = db.prepare(
    "SELECT id FROM bookings WHERE stylist_id IS ? AND appointment_date=? AND appointment_time=? AND status!='cancelled'"
  ).get(stylist_id||null, appointment_date, appointment_time);
  if (conflict) return res.status(409).json({error:'That time slot is no longer available. Please choose another.'});

  const r = db.prepare(
    'INSERT INTO bookings (customer_name,customer_email,customer_phone,stylist_id,service_id,appointment_date,appointment_time,notes) VALUES (?,?,?,?,?,?,?,?)'
  ).run(customer_name, customer_email, customer_phone||'', stylist_id||null, service_id, appointment_date, appointment_time, notes||'');

  const booking = db.prepare(`
    SELECT b.*, s.name as stylist_name, svc.name as service_name, svc.price_cents, svc.duration_min
    FROM bookings b
    LEFT JOIN stylists s ON b.stylist_id=s.id
    LEFT JOIN services svc ON b.service_id=svc.id
    WHERE b.id=?`).get(r.lastInsertRowid);

  // Resolve canonical email in case this address was previously merged
  const merged = db.prepare('SELECT merged_into FROM customers WHERE email=? AND merged_into IS NOT NULL').get(customer_email);
  const canonical_email = merged ? merged.merged_into : customer_email;

  // Upsert customer record under canonical email
  db.prepare(`INSERT INTO customers (email, name, phone)
    VALUES (?,?,?) ON CONFLICT(email) DO UPDATE SET
    name=CASE WHEN excluded.name!='' THEN excluded.name ELSE name END,
    phone=CASE WHEN excluded.phone!='' THEN excluded.phone ELSE phone END`)
    .run(canonical_email, customer_name, customer_phone||'');

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
  res.json(db.prepare("SELECT id,name,username,bio,role,active,photo_url FROM stylists ORDER BY role DESC, name ASC").all()));

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
  const { name, bio, role, active, new_password } = req.body;
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
  if (new_password) {
    if (new_password.length < 6) return res.status(400).json({error:'Password must be at least 6 characters'});
    updates.push('password_hash=?'); p.push(bcrypt.hashSync(new_password,10));
  }
  if (!updates.length) return res.status(400).json({error:'Nothing to update'});
  p.push(req.params.id);
  db.prepare(`UPDATE stylists SET ${updates.join(',')} WHERE id=?`).run(...p);
  res.json(db.prepare('SELECT id,name,username,bio,role,active FROM stylists WHERE id=?').get(req.params.id));
});

// ── Admin: Customers ───────────────────────────────────────────────────────
app.get('/api/admin/customers', requireAuth, (req,res) => {
  const { q } = req.query;
  let sql = `SELECT c.*, COUNT(b.id) as booking_count, MAX(b.appointment_date) as last_visit
    FROM customers c LEFT JOIN bookings b ON b.customer_email=c.email
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
  const r = db.prepare('INSERT INTO bookings (customer_name,customer_email,customer_phone,stylist_id,service_id,appointment_date,appointment_time,notes,status) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(customer_name, customer_email, customer_phone||'', stylist_id||null, service_id, appointment_date, appointment_time, notes||'', 'confirmed');
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

// Admin: Schedule view
app.get('/api/admin/schedule', requireAuth, (req,res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({error:'date required'});
  const barbers  = db.prepare("SELECT id,name,photo_url FROM stylists WHERE active=1 AND role IN ('barber','stylist') ORDER BY name").all();
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
      if (c.email && emailCfg.enabled && transporter) {
        await transporter.sendMail({
          from: emailCfg.from,
          to:   c.email,
          subject: subject || 'Message from Gents Barber Shop',
          html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:24px;background:#fff;border-radius:8px">${message.replace(/\n/g,'<br>')}<p style="margin-top:24px;font-size:12px;color:#aaa">Gents Barber Shop · 893 Lafayette Road, Hampton, NH</p></div>`
        });
      }
      if (c.phone && emailCfg.sms?.enabled && smsClient) {
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
  await sendReminderMessage(booking, 24).catch(e => { throw e; });
  res.json({ok:true});
});

// ── Cron: reminder scheduler ────────────────────────────────────────────────
cron.schedule('*/15 * * * *', () => {
  checkAndSendReminders();
});

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✂  Gents Barber Shop — http://localhost:${PORT}`);
  console.log(emailCfg.enabled ? '[email] SMTP configured — emails will be sent' : '[email] Dev mode — emails logged to console only');
  console.log('\nDefault logins: marcus/marcus123  james/james123  derek/derek123  admin/admin123\n');
});
