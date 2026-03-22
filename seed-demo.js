/**
 * seed-demo.js — 150 realistic customers with two appointments each:
 *   Round 1: next 30 days  (today → today+30)
 *   Round 2: 30 days later (today+31 → today+60)
 *
 * Run: node seed-demo.js
 * Safe to re-run — skips existing emails and avoids double-booking slots.
 */

const Database = require('better-sqlite3');
const path     = require('path');

const DATA_DIR = process.env.RAILWAY_ENVIRONMENT ? '/data' : __dirname;
const db = new Database(path.join(DATA_DIR, 'data.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Data pools ──────────────────────────────────────────────────────────────
const FIRST = [
  'James','John','Robert','Michael','William','David','Richard','Joseph','Thomas','Charles',
  'Christopher','Daniel','Matthew','Anthony','Mark','Donald','Steven','Paul','Andrew','Joshua',
  'Kenneth','Kevin','Brian','George','Timothy','Ronald','Edward','Jason','Jeffrey','Ryan',
  'Jacob','Gary','Nicholas','Eric','Jonathan','Stephen','Larry','Justin','Scott','Brandon',
  'Raymond','Gregory','Frank','Benjamin','Samuel','Patrick','Jack','Dennis','Jerry','Tyler',
  'Aaron','Jose','Henry','Adam','Douglas','Nathan','Peter','Zachary','Kyle','Walter',
  'Harold','Jeremy','Ethan','Carl','Keith','Roger','Gerald','Christian','Terry','Sean',
  'Arthur','Austin','Noah','Lawrence','Jesse','Joe','Bryan','Billy','Jordan','Albert',
  'Dylan','Bruce','Willie','Randy','Alan','Juan','Wayne','Roy','Ralph','Eugene',
  'Carlos','Russell','Bobby','Victor','Martin','Ernest','Phillip','Todd','Craig','Shawn',
  'Clarence','Philip','Johnny','Earl','Jimmy','Antonio','Danny','Tony','Louis','Mike',
  'Liam','Mason','Aiden','Logan','Lucas','Elijah','Oliver','Jackson','Caleb','Isaiah',
  'Connor','Landon','Hunter','Cameron','Evan','Gavin','Sebastian','Jayden','Carter','Luke',
  'Wyatt','Owen','Lincoln','Eli','Brayden','Isaiah','Xavier','Julian','Colton','Dominic',
  'Maxwell','Cohen','Jaxon','Jace','Chase','Greyson','Weston','Beckham','Grayson','Roman',
];

const LAST = [
  'Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Wilson','Anderson',
  'Taylor','Thomas','Hernandez','Moore','Martin','Jackson','Thompson','White','Lopez','Lee',
  'Gonzalez','Harris','Clark','Lewis','Robinson','Walker','Perez','Hall','Young','Allen',
  'Sanchez','Wright','King','Scott','Green','Baker','Adams','Nelson','Hill','Ramirez',
  'Campbell','Mitchell','Roberts','Carter','Phillips','Evans','Turner','Torres','Parker','Collins',
  'Edwards','Stewart','Flores','Morris','Nguyen','Murphy','Rivera','Cook','Rogers','Morgan',
  'Peterson','Cooper','Reed','Bailey','Bell','Gomez','Kelly','Howard','Ward','Cox',
  'Diaz','Richardson','Wood','Watson','Brooks','Bennett','Gray','James','Reyes','Cruz',
  'Hughes','Price','Myers','Long','Foster','Sanders','Ross','Morales','Powell','Sullivan',
  'Russell','Ortiz','Jenkins','Gutierrez','Perry','Butler','Barnes','Fisher','Henderson','Coleman',
  'Simmons','Patterson','Jordan','Reynolds','Hamilton','Graham','Kim','Gonzales','Alexander','Ramos',
  'Wallace','Griffin','West','Cole','Hayes','Chavez','Gibson','Bryant','Ellis','Stevens',
  'Murray','Ford','Marshall','Owens','McDonald','Harrison','Ruiz','Kennedy','Wells','Alvarez',
  'Woods','Mendoza','Castillo','Olson','Webb','Washington','Tucker','Freeman','Burns','Henry',
  'Warren','Dixon','Carroll','Lane','Riley','Armstrong','Watts','Marsh','Dunn','Pierce',
];

const DOMAINS = [
  'gmail.com','yahoo.com','outlook.com','hotmail.com','icloud.com',
  'comcast.net','verizon.net','live.com','me.com','aol.com',
];

const NOTES_POOL = [
  '#2 on sides, scissors on top','Low fade, keep length on top','High skin fade',
  'Tapered sides, textured top','Line-up and shape-up','Scissor cut only, no clippers',
  'Drop fade, natural on top','Blended fade, trim beard too','Classic taper',
  'Buzz cut #3 all over','Hard part on left side','Pompadour style',
  'Undercut, disconnected','French crop','Ivy league cut',
  'Number 1 fade','Tight fade','Medium fade, curly hair',
  'Bald fade','Taper with beard trim','Just a trim, nothing too short',
  '','','','','','','','',
];

const PREFS_POOL = [
  '#2 guard sides, #4 top','Scissors only on top','No razor on neck — sensitive skin',
  'Clippers on sides only','Hard part on the left','Taper tight behind the ears',
  'Low fade only — never high','Trim beard to shape','Leave the top long',
  'Line-up every time','Moisturizer after cut','Hot towel finish preferred',
  '','','','',
];

const ALL_SLOTS = [];
for (let h = 9; h < 17; h++) {
  ALL_SLOTS.push(`${String(h).padStart(2,'0')}:00`);
  ALL_SLOTS.push(`${String(h).padStart(2,'0')}:30`);
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function dateStr(daysFromToday) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function randomPhone() {
  const prefixes = ['555','234','345','456','678','789','876','765','654','543'];
  return `603${pick(prefixes)}${String(rand(1000,9999))}`;
}

function uniqueEmail(first, last, used) {
  const domain = pick(DOMAINS);
  const base   = `${first.toLowerCase()}${last.toLowerCase()}`;
  const variants = [
    `${first.toLowerCase()}.${last.toLowerCase()}@${domain}`,
    `${base}@${domain}`,
    `${first[0].toLowerCase()}${last.toLowerCase()}@${domain}`,
    `${base}${rand(1,99)}@${domain}`,
    `${first.toLowerCase()}${rand(100,999)}@${domain}`,
    `${base}${rand(100,9999)}@${domain}`,
  ];
  for (const email of variants) {
    if (!used.has(email)) { used.add(email); return email; }
  }
  const fallback = `customer${rand(10000,99999)}@gmail.com`;
  used.add(fallback);
  return fallback;
}

// ── Load existing data ───────────────────────────────────────────────────────
const barbers  = db.prepare("SELECT id FROM stylists WHERE active=1 AND role IN ('barber','stylist')").all().map(r => r.id);
const services = db.prepare('SELECT id FROM services WHERE active=1').all().map(r => r.id);

if (!barbers.length)  { console.error('❌  No active barbers found. Start the server once to seed them.'); process.exit(1); }
if (!services.length) { console.error('❌  No active services found.'); process.exit(1); }

console.log(`\nBarbers  : [${barbers.join(', ')}]`);
console.log(`Services : [${services.join(', ')}]`);

// ── Track used slots to avoid double-booking ─────────────────────────────────
const usedSlots = new Set();
db.prepare("SELECT appointment_date, appointment_time, stylist_id FROM bookings WHERE status != 'cancelled' AND stylist_id IS NOT NULL")
  .all().forEach(b => usedSlots.add(`${b.appointment_date}|${b.appointment_time}|${b.stylist_id}`));

function findFreeSlot(dayMin, dayMax) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const date   = dateStr(rand(dayMin, dayMax));
    const time   = pick(ALL_SLOTS);
    const barber = pick(barbers);
    const key    = `${date}|${time}|${barber}`;
    if (!usedSlots.has(key)) {
      usedSlots.add(key);
      return { date, time, barber };
    }
  }
  return null;
}

// ── Prepared statements ──────────────────────────────────────────────────────
const insertCustomer = db.prepare(`
  INSERT OR IGNORE INTO customers (email, name, phone, notes, preferences, marketing_opt_in)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const insertBooking = db.prepare(`
  INSERT INTO bookings
    (customer_name, customer_email, customer_phone, stylist_id, service_id,
     appointment_date, appointment_time, notes, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// ── Seed ─────────────────────────────────────────────────────────────────────
const usedEmails = new Set(db.prepare('SELECT email FROM customers').all().map(r => r.email));
const usedNames  = new Set(db.prepare('SELECT name FROM customers').all().map(r => r.name));

let bookingsCreated = 0, slotsSkipped = 0, customersCreated = 0;

const run = db.transaction(() => {
  for (let i = 0; i < 150; i++) {
    // Unique full name
    let first, last, fullName, nameAttempts = 0;
    do {
      first    = pick(FIRST);
      last     = pick(LAST);
      fullName = `${first} ${last}`;
      nameAttempts++;
    } while (usedNames.has(fullName) && nameAttempts < 100);
    usedNames.add(fullName);

    const email  = uniqueEmail(first, last, usedEmails);
    const phone  = randomPhone();
    const notes  = pick(NOTES_POOL);
    const prefs  = pick(PREFS_POOL);
    const optIn  = Math.random() > 0.3 ? 1 : 0; // 70% opted in for marketing

    const res = insertCustomer.run(email, fullName, phone, notes, prefs, optIn);
    if (res.changes > 0) customersCreated++;

    // Round 1: appointment in next 1–30 days (mix of confirmed/pending)
    const slot1 = findFreeSlot(1, 30);
    if (slot1) {
      const status1 = Math.random() > 0.2 ? 'confirmed' : 'pending';
      insertBooking.run(fullName, email, phone, slot1.barber, pick(services),
                        slot1.date, slot1.time, notes, status1);
      bookingsCreated++;
    } else {
      console.warn(`  ⚠  No free slot (round 1) for ${fullName}`);
      slotsSkipped++;
    }

    // Round 2: return visit 31–60 days from now (all pending — not yet confirmed)
    const slot2 = findFreeSlot(31, 60);
    if (slot2) {
      insertBooking.run(fullName, email, phone, slot2.barber, pick(services),
                        slot2.date, slot2.time, notes, 'pending');
      bookingsCreated++;
    } else {
      console.warn(`  ⚠  No free slot (round 2) for ${fullName}`);
      slotsSkipped++;
    }
  }
});

console.log('\nSeeding 150 demo customers (2 appointments each)…\n');
run();

const totalBookings  = db.prepare('SELECT COUNT(*) as c FROM bookings').get().c;
const totalCustomers = db.prepare('SELECT COUNT(*) as c FROM customers WHERE merged_into IS NULL').get().c;
const upcoming       = db.prepare("SELECT COUNT(*) as c FROM bookings WHERE appointment_date >= date('now') AND appointment_date <= date('now','+30 days')").get().c;
const returning      = db.prepare("SELECT COUNT(*) as c FROM bookings WHERE appointment_date > date('now','+30 days') AND appointment_date <= date('now','+60 days')").get().c;

console.log(`✅  Seed complete!`);
console.log(`   Customers created  : ${customersCreated}`);
console.log(`   Bookings created   : ${bookingsCreated}`);
console.log(`   Slots skipped      : ${slotsSkipped}`);
console.log(`   ─────────────────────────────────`);
console.log(`   Total customers    : ${totalCustomers}`);
console.log(`   Total bookings     : ${totalBookings}`);
console.log(`   Next 30 days       : ${upcoming} appointments`);
console.log(`   Days 31–60 (return): ${returning} appointments`);
console.log('');
