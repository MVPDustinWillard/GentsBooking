// Demo data seed — 3 months of realistic bookings for client demo
const Database = require('better-sqlite3');
const path     = require('path');

const db = new Database(path.join(__dirname, 'data.db'));

const BARBER_IDS  = [1, 2, 3]; // Marcus, James, Derek
const SERVICE_IDS = [1, 2, 3, 4, 5];
// Weight services so basics are most common
const SERVICE_WEIGHTS = [1,1,1,1,1,1,1,2,2,3,3,4,5]; // index into SERVICE_IDS

const SLOTS = [];
for (let h = 9; h < 17; h++) {
  SLOTS.push(`${String(h).padStart(2,'0')}:00`);
  SLOTS.push(`${String(h).padStart(2,'0')}:30`);
}

const FIRST_NAMES = [
  'James','Michael','Robert','John','David','William','Richard','Thomas','Charles','Christopher',
  'Daniel','Matthew','Anthony','Mark','Donald','Steven','Paul','Andrew','Joshua','Kevin',
  'Brian','George','Timothy','Ronald','Edward','Jason','Jeffrey','Ryan','Jacob','Gary',
  'Nicholas','Eric','Jonathan','Stephen','Larry','Justin','Scott','Brandon','Benjamin','Samuel',
  'Raymond','Gregory','Frank','Alexander','Patrick','Jack','Dennis','Jerry','Tyler','Aaron',
  'Henry','Douglas','Walter','Peter','Harold','Kyle','Carl','Arthur','Gerald','Roger',
];
const LAST_NAMES = [
  'Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Wilson','Anderson',
  'Taylor','Thomas','Moore','Jackson','Martin','Lee','Thompson','White','Harris','Clark',
  'Lewis','Robinson','Walker','Young','Allen','King','Wright','Scott','Green','Baker',
  'Adams','Nelson','Carter','Mitchell','Perez','Roberts','Turner','Phillips','Campbell','Parker',
  'Evans','Edwards','Collins','Stewart','Morris','Rogers','Reed','Cook','Morgan','Bell',
];
const NOTES_POOL = [
  '', '', '', '', '', // Most bookings have no notes
  'Please leave it a bit longer on top',
  'Fade on the sides',
  'Trim the beard too if possible',
  'Same as last time',
  'Going to a wedding this weekend',
  'First time here — referred by a friend',
  'Allergic to certain hair products',
  'Likes to keep it short',
  'Low fade please',
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function pickWeighted(arr, weights) { return arr[weights[Math.floor(Math.random() * weights.length)]]; }

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}
function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// Status distribution: weight toward pending/confirmed for future, completed for past
function pickStatus(dateStr) {
  const today = new Date().toISOString().split('T')[0];
  if (dateStr < today) {
    // Past: mostly completed, some cancelled
    const r = Math.random();
    if (r < 0.78) return 'completed';
    if (r < 0.92) return 'confirmed';
    return 'cancelled';
  } else {
    // Future: mix of pending/confirmed
    const r = Math.random();
    if (r < 0.45) return 'pending';
    if (r < 0.90) return 'confirmed';
    return 'cancelled';
  }
}

const ins = db.prepare(`
  INSERT OR IGNORE INTO bookings
    (customer_name, customer_email, customer_phone, stylist_id, service_id, appointment_date, appointment_time, status, notes)
  VALUES (?,?,?,?,?,?,?,?,?)
`);

const insCustomer = db.prepare(`
  INSERT OR IGNORE INTO customers (email, name, phone) VALUES (?,?,?)
`);

// Generate a pool of realistic customers (some repeat visitors)
const customerPool = [];
for (let i = 0; i < 60; i++) {
  const first = pick(FIRST_NAMES);
  const last  = pick(LAST_NAMES);
  const name  = `${first} ${last}`;
  const email = `${first.toLowerCase()}.${last.toLowerCase()}${Math.floor(Math.random()*900)+100}@example.com`;
  const phone = `603${String(Math.floor(Math.random()*9000000)+1000000)}`;
  customerPool.push({ name, email, phone });
}

const today    = new Date();
const start    = addDays(today, -30); // Include past 30 days so there are completed bookings
const end      = addDays(today, 90);  // 3 months out

// Track which barber+date+time slots are already used
const usedSlots = new Set();

// Pre-load existing booked slots to avoid conflicts
const existing = db.prepare('SELECT stylist_id, appointment_date, appointment_time FROM bookings').all();
existing.forEach(b => usedSlots.add(`${b.stylist_id}|${b.appointment_date}|${b.appointment_time}`));

let inserted = 0;
const seedTx = db.transaction(() => {
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
    const dow = d.getDay(); // 0=Sun,6=Sat
    if (dow === 0) continue; // closed Sundays

    const dateStr = toDateStr(d);
    // Saturdays are busy, weekdays moderate, skip some slots to be realistic
    const density = dow === 6 ? 0.75 : 0.40;

    BARBER_IDS.forEach(barberId => {
      SLOTS.forEach(slot => {
        if (Math.random() > density) return; // sparse-ish schedule

        const key = `${barberId}|${dateStr}|${slot}`;
        if (usedSlots.has(key)) return;

        const customer   = pick(customerPool);
        const serviceId  = pickWeighted(SERVICE_IDS, SERVICE_WEIGHTS);
        const status     = pickStatus(dateStr);
        const notes      = pick(NOTES_POOL);

        ins.run(
          customer.name, customer.email, customer.phone,
          barberId, serviceId, dateStr, slot, status, notes
        );
        insCustomer.run(customer.email, customer.name, customer.phone);
        usedSlots.add(key);
        inserted++;
      });
    });
  }
});

seedTx();

const total = db.prepare('SELECT COUNT(*) as c FROM bookings').get().c;
console.log(`✓ Inserted ${inserted} demo bookings. Total in DB: ${total}`);
console.log(`  Date range: ${toDateStr(start)} → ${toDateStr(end)}`);
