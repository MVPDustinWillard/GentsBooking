const express    = require('express');
const Database   = require('better-sqlite3');
const bcrypt     = require('bcryptjs');
const session    = require('express-session');
const nodemailer = require('nodemailer');
const multer     = require('multer');
const twilio     = require('twilio');
const path       = require('path');
const fs         = require('fs');
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

// ── Multer (photo uploads) ─────────────────────────────────────────────────
const uploadsDir = process.env.RAILWAY_ENVIRONMENT
  ? '/data/uploads'
  : path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    const id  = req.params.id || req.session.stylistId;
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

const requireAuth  = (req,res,next) => req.session.stylistId ? next() : res.status(401).json({error:'Not authenticated'});
const requireAdmin = (req,res,next) => {
  if (!req.session.stylistId) return res.status(401).json({error:'Not authenticated'});
  if (req.session.role !== 'admin') return res.status(403).json({error:'Admins only'});
  next();
};

// ── Public API ─────────────────────────────────────────────────────────────
app.get('/api/services', (_req,res) => res.json(db.prepare('SELECT * FROM services WHERE active=1').all()));

app.get('/api/stylists', (_req,res) =>
  res.json(db.prepare("SELECT id,name,bio,photo_url FROM stylists WHERE active=1 AND role IN ('barber','stylist')").all()));

app.get('/api/availability', (req,res) => {
  const { stylist_id, date } = req.query;
  if (!date) return res.status(400).json({error:'date required'});
  const booked = stylist_id
    ? db.prepare("SELECT appointment_time FROM bookings WHERE stylist_id=? AND appointment_date=? AND status!='cancelled'").all(stylist_id,date)
    : db.prepare("SELECT appointment_time FROM bookings WHERE appointment_date=? AND status!='cancelled'").all(date);
  const taken = new Set(booked.map(r=>r.appointment_time));
  res.json({ slots: ALL_SLOTS.filter(s=>!taken.has(s)) });
});

app.post('/api/bookings', async (req,res) => {
  const { customer_name, customer_email, customer_phone, stylist_id, service_id, appointment_date, appointment_time, notes } = req.body;
  if (!customer_name||!customer_email||!service_id||!appointment_date||!appointment_time)
    return res.status(400).json({error:'Missing required fields'});

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
  req.session.stylistId   = s.id;
  req.session.stylistName = s.name;
  req.session.role        = s.role;
  res.json({id:s.id, name:s.name, role:s.role});
});

app.post('/api/auth/logout', (req,res) => { req.session.destroy(); res.json({ok:true}); });

app.get('/api/auth/me', (req,res) => {
  if (!req.session.stylistId) return res.status(401).json({error:'Not authenticated'});
  const s = db.prepare('SELECT photo_url FROM stylists WHERE id=?').get(req.session.stylistId);
  res.json({id:req.session.stylistId, name:req.session.stylistName, role:req.session.role, photo_url:s?.photo_url||''});
});

// Upload own photo
app.post('/api/auth/upload-photo', requireAuth, upload.single('photo'), (req,res) => {
  if (!req.file) return res.status(400).json({error:'No file uploaded'});
  // Delete old photo if exists
  const old = db.prepare('SELECT photo_url FROM stylists WHERE id=?').get(req.session.stylistId);
  if (old?.photo_url) {
    const oldPath = path.join(__dirname, 'public', old.photo_url);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  const photo_url = `/uploads/${req.file.filename}`;
  db.prepare('UPDATE stylists SET photo_url=? WHERE id=?').run(photo_url, req.session.stylistId);
  res.json({photo_url});
});

// Change own password
app.post('/api/auth/change-password', requireAuth, (req,res) => {
  const { current_password, new_password } = req.body;
  if (!current_password||!new_password) return res.status(400).json({error:'Both fields required'});
  if (new_password.length < 6) return res.status(400).json({error:'New password must be at least 6 characters'});
  const s = db.prepare('SELECT * FROM stylists WHERE id=?').get(req.session.stylistId);
  if (!bcrypt.compareSync(current_password, s.password_hash))
    return res.status(401).json({error:'Current password is incorrect'});
  db.prepare('UPDATE stylists SET password_hash=? WHERE id=?').run(bcrypt.hashSync(new_password,10), req.session.stylistId);
  res.json({ok:true});
});

// ── Admin: Bookings ────────────────────────────────────────────────────────
app.get('/api/admin/bookings', requireAuth, (req,res) => {
  const { date, status, stylist_id } = req.query;
  let q = `
    SELECT b.*, s.name as stylist_name, svc.name as service_name, svc.price_cents, svc.duration_min
    FROM bookings b
    LEFT JOIN stylists s ON b.stylist_id=s.id
    LEFT JOIN services svc ON b.service_id=svc.id
    WHERE 1=1`;
  const p = [];
  if (stylist_id) { q+=' AND b.stylist_id=?'; p.push(stylist_id); }
  if (date)   { q+=' AND b.appointment_date=?'; p.push(date); }
  if (status) { q+=' AND b.status=?'; p.push(status); }
  q+=' ORDER BY b.appointment_date ASC, b.appointment_time ASC';
  res.json(db.prepare(q).all(...p));
});

app.patch('/api/admin/bookings/:id', requireAdmin, (req,res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(req.params.id);
  if (!b) return res.status(404).json({error:'Booking not found'});
  const { status, notes, stylist_id } = req.body;
  const updates=[]; const p=[];
  if (status!==undefined)     { updates.push('status=?');     p.push(status); }
  if (notes!==undefined)      { updates.push('notes=?');      p.push(notes); }
  if (stylist_id!==undefined) { updates.push('stylist_id=?'); p.push(stylist_id||null); }
  if (!updates.length) return res.status(400).json({error:'Nothing to update'});
  p.push(req.params.id);
  db.prepare(`UPDATE bookings SET ${updates.join(',')} WHERE id=?`).run(...p);
  res.json(db.prepare('SELECT * FROM bookings WHERE id=?').get(req.params.id));
});

// ── Admin: Stylists (account management) ──────────────────────────────────
app.get('/api/admin/stylists', requireAdmin, (_req,res) =>
  res.json(db.prepare("SELECT id,name,username,bio,role,active,photo_url FROM stylists ORDER BY role DESC, name ASC").all()));

// Admin upload photo for any member
app.post('/api/admin/stylists/:id/photo', requireAdmin, upload.single('photo'), (req,res) => {
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

app.post('/api/admin/stylists', requireAdmin, (req,res) => {
  const { name, username, password, bio, role } = req.body;
  if (!name||!username||!password) return res.status(400).json({error:'name, username and password are required'});
  if (password.length < 6) return res.status(400).json({error:'Password must be at least 6 characters'});
  const exists = db.prepare('SELECT id FROM stylists WHERE username=?').get(username);
  if (exists) return res.status(409).json({error:'Username already taken'});
  const r = db.prepare('INSERT INTO stylists (name,username,password_hash,bio,role) VALUES (?,?,?,?,?)')
    .run(name.trim(), username.trim().toLowerCase(), bcrypt.hashSync(password,10), bio||'', role||'barber');
  res.status(201).json(db.prepare('SELECT id,name,username,bio,role,active FROM stylists WHERE id=?').get(r.lastInsertRowid));
});

app.patch('/api/admin/stylists/:id', requireAdmin, (req,res) => {
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
  const { notes, name, phone } = req.body;
  const c = db.prepare('SELECT * FROM customers WHERE email=?').get(req.params.email);
  if (!c) return res.status(404).json({error:'Customer not found'});
  const updates=[]; const p=[];
  if (notes!==undefined) { updates.push('notes=?'); p.push(notes); }
  if (name!==undefined)  { updates.push('name=?');  p.push(name.trim()); }
  if (phone!==undefined) { updates.push('phone=?'); p.push(phone.trim()); }
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

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✂  Gents Barber Shop — http://localhost:${PORT}`);
  console.log(emailCfg.enabled ? '[email] SMTP configured — emails will be sent' : '[email] Dev mode — emails logged to console only');
  console.log('\nDefault logins: marcus/marcus123  james/james123  derek/derek123  admin/admin123\n');
});
