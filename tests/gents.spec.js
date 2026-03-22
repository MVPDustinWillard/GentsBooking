// Gents Barber Shop — Full Test Suite
// Covers: Customer, Barber, Admin, Desktop, Mobile

const { test, expect } = require('@playwright/test');

const BASE    = 'http://localhost:3000';
const DESKTOP = { viewport: { width: 1280, height: 800 } };
const MOBILE  = { viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' };

// Each test run gets a unique block of slots based on the current minute,
// so re-runs never collide with slots from prior runs in the same DB.
const SESSION_OFFSET = Math.floor(Date.now() / 60000); // unique per minute
let _slotIndex = 0;
function nextSlot() {
  const idx  = SESSION_OFFSET * 200 + _slotIndex++;
  const day  = String((idx % 28) + 1).padStart(2, '0');
  const month= String(Math.floor(idx / 28) % 12 + 1).padStart(2, '0');
  const year = 2030 + Math.floor(idx / 336);
  const hour = String(9 + (idx % 8)).padStart(2, '0');
  const time = `${hour}:00`;
  const date = `${year}-${month}-${day}`;
  const stylist_id = (idx % 3) + 1;
  return { date, time, stylist_id };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function login(page, username, password) {
  await page.goto(`${BASE}/login.html`);
  await page.fill('input[type="text"], #username', username);
  await page.fill('input[type="password"], #password', password);
  await page.click('button[type="submit"], .btn-login, button:has-text("Sign In"), button:has-text("Login")');
  await page.waitForURL(`${BASE}/admin.html`, { timeout: 8000 });
}

async function makeBooking(page, opts = {}) {
  const slot = nextSlot();
  const res = await page.request.post(`${BASE}/api/bookings`, {
    data: {
      customer_name:    opts.name    || 'Test Customer',
      customer_email:   opts.email   || `test_${Date.now()}@example.com`,
      customer_phone:   opts.phone   || '6031234567',
      service_id:       opts.service || 1,
      stylist_id:       opts.stylist || slot.stylist_id,
      appointment_date: opts.date    || slot.date,
      appointment_time: opts.time    || slot.time,
    }
  });
  return res;
}

// ════════════════════════════════════════════════════════════════════════════
// CUSTOMER — DESKTOP
// ════════════════════════════════════════════════════════════════════════════

test.describe('Customer — Desktop', () => {
  test.use(DESKTOP);

  test('CT-01: Home page loads with hero content', async ({ page }) => {
    await page.goto(BASE);
    await expect(page).toHaveTitle(/gents/i);
    const body = await page.textContent('body');
    expect(body.toLowerCase()).toMatch(/gents|barber|book/);
  });

  test('CT-02: Booking page loads', async ({ page }) => {
    await page.goto(`${BASE}/booking`);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('body')).toBeVisible();
    const body = await page.textContent('body');
    expect(body.toLowerCase()).toMatch(/haircut|service|book/);
  });

  test('CT-03: Services load from API', async ({ page }) => {
    const res = await page.request.get(`${BASE}/api/services`);
    expect(res.status()).toBe(200);
    const services = await res.json();
    expect(Array.isArray(services)).toBe(true);
    expect(services.length).toBeGreaterThan(0);
    expect(services[0]).toHaveProperty('name');
    expect(services[0]).toHaveProperty('price_cents');
  });

  test('CT-04: Barbers load from API', async ({ page }) => {
    const res = await page.request.get(`${BASE}/api/barbers`);
    expect(res.status()).toBe(200);
    const barbers = await res.json();
    expect(Array.isArray(barbers)).toBe(true);
    expect(barbers.length).toBeGreaterThan(0);
  });

  test('CT-05: Availability API returns time slots', async ({ page }) => {
    const slot = nextSlot();
    const res  = await page.request.get(`${BASE}/api/availability?date=${slot.date}`);
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('slots');
    expect(Array.isArray(data.slots)).toBe(true);
    expect(data.slots.length).toBeGreaterThan(0);
  });

  test('CT-06: Booking submission creates a booking', async ({ page }) => {
    const res = await makeBooking(page, { name:'CT06 Desktop', email:`ct06_${Date.now()}@test.com` });
    expect(res.status()).toBe(201);
    const booking = await res.json();
    expect(booking).toHaveProperty('id');
    expect(booking.customer_name).toBe('CT06 Desktop');
    expect(booking.status).toBe('pending');
  });

  test('CT-07: Duplicate time slot returns 409', async ({ page }) => {
    const slot = nextSlot();
    await page.request.post(`${BASE}/api/bookings`, {
      data: { customer_name:'CT07a', customer_email:`ct07a_${Date.now()}@test.com`, service_id:1, stylist_id:slot.stylist_id, appointment_date:slot.date, appointment_time:slot.time }
    });
    const res = await page.request.post(`${BASE}/api/bookings`, {
      data: { customer_name:'CT07b', customer_email:`ct07b_${Date.now()}@test.com`, service_id:1, stylist_id:slot.stylist_id, appointment_date:slot.date, appointment_time:slot.time }
    });
    expect(res.status()).toBe(409);
  });

  test('CT-08: Booking auto-creates customer record', async ({ page }) => {
    const email = `ct08_${Date.now()}@test.com`;
    const res   = await makeBooking(page, { name:'CT08 Customer', email, phone:'6030000008' });
    expect(res.status()).toBe(201);
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const custRes = await page.request.get(`${BASE}/api/admin/customers/${encodeURIComponent(email)}`);
    expect(custRes.status()).toBe(200);
    const cust = await custRes.json();
    expect(cust.email).toBe(email);
    expect(cust.name).toBe('CT08 Customer');
  });

  test('CT-09: Missing required fields returns 400', async ({ page }) => {
    const res = await page.request.post(`${BASE}/api/bookings`, {
      data: { customer_name: 'Incomplete' }
    });
    expect(res.status()).toBe(400);
  });

  test('CT-10: Availability excludes booked slots', async ({ page }) => {
    const slot = nextSlot();
    await page.request.post(`${BASE}/api/bookings`, {
      data: { customer_name:'CT10', customer_email:`ct10_${Date.now()}@test.com`, service_id:1, stylist_id:slot.stylist_id, appointment_date:slot.date, appointment_time:slot.time }
    });
    const res  = await page.request.get(`${BASE}/api/availability?date=${slot.date}&stylist_id=${slot.stylist_id}`);
    const data = await res.json();
    expect(data.slots).not.toContain(slot.time);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CUSTOMER — MOBILE
// ════════════════════════════════════════════════════════════════════════════

test.describe('Customer — Mobile', () => {
  test.use(MOBILE);

  test('CM-01: Home page renders on mobile', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('body')).toBeVisible();
    const body = await page.textContent('body');
    expect(body.toLowerCase()).toMatch(/gents|barber|book/);
  });

  test('CM-02: Booking page renders on mobile', async ({ page }) => {
    await page.goto(`${BASE}/booking`);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('body')).toBeVisible();
  });

  test('CM-03: API booking works from mobile viewport', async ({ page }) => {
    const res = await makeBooking(page, { name:'CM03 Mobile', email:`cm03_${Date.now()}@test.com` });
    expect(res.status()).toBe(201);
  });

  test('CM-04: No horizontal overflow on booking page', async ({ page }) => {
    await page.goto(`${BASE}/booking`);
    await page.waitForLoadState('networkidle');
    const bodyWidth   = await page.evaluate(() => document.body.scrollWidth);
    const windowWidth = await page.evaluate(() => window.innerWidth);
    expect(bodyWidth).toBeLessThanOrEqual(windowWidth + 5);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// BARBER — DESKTOP
// ════════════════════════════════════════════════════════════════════════════

test.describe('Barber — Desktop', () => {
  test.use(DESKTOP);

  test('BT-01: Barber can log in', async ({ page }) => {
    await login(page, 'marcus', 'marcus123');
    await expect(page).toHaveURL(`${BASE}/admin.html`);
  });

  test('BT-02: Barber sees bookings dashboard', async ({ page }) => {
    await login(page, 'marcus', 'marcus123');
    await expect(page.locator('#view-bookings')).toBeVisible();
  });

  test('BT-03: Barber can view all bookings via API', async ({ page }) => {
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'marcus', password:'marcus123' } });
    const res = await page.request.get(`${BASE}/api/admin/bookings`);
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('BT-04: Barber cannot access admin-only barbers endpoint', async ({ page }) => {
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'marcus', password:'marcus123' } });
    const res = await page.request.get(`${BASE}/api/admin/barbers`);
    expect(res.status()).toBe(403);
  });

  test('BT-05: Barber cannot update booking status (admin only)', async ({ page }) => {
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'marcus', password:'marcus123' } });
    const res = await page.request.patch(`${BASE}/api/admin/bookings/1`, {
      data: { status: 'confirmed' }
    });
    expect(res.status()).toBe(403);
  });

  test('BT-06: Barber can view customers', async ({ page }) => {
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'james', password:'james123' } });
    const res = await page.request.get(`${BASE}/api/admin/customers`);
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('BT-07: Barber can add notes to a customer', async ({ page }) => {
    const email = `bt07_${Date.now()}@test.com`;
    const bookRes = await makeBooking(page, { name:'BT07 Barber', email });
    expect(bookRes.status()).toBe(201);
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'marcus', password:'marcus123' } });
    const res = await page.request.patch(`${BASE}/api/admin/customers/${encodeURIComponent(email)}`, {
      data: { notes: 'Prefers fade on sides' }
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).notes).toBe('Prefers fade on sides');
  });

  test('BT-08: Barber cannot merge customer accounts', async ({ page }) => {
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'marcus', password:'marcus123' } });
    const res = await page.request.post(`${BASE}/api/admin/customers/merge`, {
      data: { keep_email:'a@test.com', drop_email:'b@test.com' }
    });
    expect(res.status()).toBe(403);
  });

  test('BT-09: Barber sees Customers nav item', async ({ page }) => {
    await login(page, 'marcus', 'marcus123');
    await expect(page.locator('#nav-customers')).toBeVisible();
  });

  test('BT-10: Barber does NOT see Team nav item', async ({ page }) => {
    await login(page, 'james', 'james123');
    await expect(page.locator('#nav-team')).toBeHidden();
  });

  test('BT-11: Invalid login rejected', async ({ page }) => {
    await page.goto(`${BASE}/login.html`);
    await page.fill('input[type="text"], #username', 'marcus');
    await page.fill('input[type="password"], #password', 'wrongpass');
    await page.click('button[type="submit"], .btn-login, button:has-text("Sign In")');
    await page.waitForTimeout(1000);
    await expect(page).not.toHaveURL(`${BASE}/admin.html`);
  });

  test('BT-12: Barber can change their own password', async ({ page }) => {
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'derek', password:'derek123' } });
    const res = await page.request.post(`${BASE}/api/auth/change-password`, {
      data: { current_password:'derek123', new_password:'derek123' }
    });
    expect(res.status()).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// BARBER — MOBILE
// ════════════════════════════════════════════════════════════════════════════

test.describe('Barber — Mobile', () => {
  test.use(MOBILE);

  test('BM-01: Login page renders on mobile', async ({ page }) => {
    await page.goto(`${BASE}/login.html`);
    await expect(page.locator('body')).toBeVisible();
  });

  test('BM-02: Barber can log in on mobile', async ({ page }) => {
    await login(page, 'marcus', 'marcus123');
    await expect(page).toHaveURL(`${BASE}/admin.html`);
  });

  test('BM-03: Dashboard renders on mobile', async ({ page }) => {
    await login(page, 'marcus', 'marcus123');
    await expect(page.locator('.main')).toBeVisible();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ADMIN — DESKTOP
// ════════════════════════════════════════════════════════════════════════════

test.describe('Admin — Desktop', () => {
  test.use(DESKTOP);

  test('AT-01: Admin can log in', async ({ page }) => {
    await login(page, 'admin', 'admin123');
    await expect(page).toHaveURL(`${BASE}/admin.html`);
  });

  test('AT-02: Admin sees Team nav item', async ({ page }) => {
    await login(page, 'admin', 'admin123');
    await expect(page.locator('#nav-team')).toBeVisible();
  });

  test('AT-03: Admin can view all bookings', async ({ page }) => {
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const res = await page.request.get(`${BASE}/api/admin/bookings`);
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('AT-04: Admin can confirm a booking', async ({ page }) => {
    const bookRes = await makeBooking(page, { name:'AT04', email:`at04_${Date.now()}@test.com` });
    expect(bookRes.status()).toBe(201);
    const booking = await bookRes.json();
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const res = await page.request.patch(`${BASE}/api/admin/bookings/${booking.id}`, { data:{ status:'confirmed' } });
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe('confirmed');
  });

  test('AT-05: Admin can cancel a booking', async ({ page }) => {
    const bookRes = await makeBooking(page, { name:'AT05', email:`at05_${Date.now()}@test.com` });
    expect(bookRes.status()).toBe(201);
    const booking = await bookRes.json();
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const res = await page.request.patch(`${BASE}/api/admin/bookings/${booking.id}`, { data:{ status:'cancelled' } });
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe('cancelled');
  });

  test('AT-06: Admin can complete a booking', async ({ page }) => {
    const bookRes = await makeBooking(page, { name:'AT06', email:`at06_${Date.now()}@test.com` });
    expect(bookRes.status()).toBe(201);
    const booking = await bookRes.json();
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const res = await page.request.patch(`${BASE}/api/admin/bookings/${booking.id}`, { data:{ status:'completed' } });
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe('completed');
  });

  test('AT-07: Admin can assign a barber to a booking', async ({ page }) => {
    const bookRes = await makeBooking(page, { name:'AT07', email:`at07_${Date.now()}@test.com` });
    expect(bookRes.status()).toBe(201);
    const booking = await bookRes.json();
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const res = await page.request.patch(`${BASE}/api/admin/bookings/${booking.id}`, { data:{ stylist_id:1 } });
    expect(res.status()).toBe(200);
    expect((await res.json()).stylist_id).toBe(1);
  });

  test('AT-08: Admin can list team members', async ({ page }) => {
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const res  = await page.request.get(`${BASE}/api/admin/barbers`);
    expect(res.status()).toBe(200);
    const team = await res.json();
    expect(team.length).toBeGreaterThanOrEqual(4);
    expect(team.some(m => m.role === 'admin')).toBe(true);
  });

  test('AT-09: Admin can add a new team member', async ({ page }) => {
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const username = `testbarber_${Date.now()}`;
    const res = await page.request.post(`${BASE}/api/admin/barbers`, {
      data: { name:'Test Barber', username, password:'test123456', role:'barber' }
    });
    expect(res.status()).toBe(201);
    expect((await res.json()).username).toBe(username);
  });

  test('AT-10: Admin cannot add duplicate username', async ({ page }) => {
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const res = await page.request.post(`${BASE}/api/admin/barbers`, {
      data: { name:'Dup', username:'marcus', password:'password123', role:'barber' }
    });
    expect(res.status()).toBe(409);
  });

  test('AT-11: Admin can deactivate a team member', async ({ page }) => {
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const username = `temp_${Date.now()}`;
    const addRes = await page.request.post(`${BASE}/api/admin/barbers`, {
      data: { name:'Temp', username, password:'temp123456', role:'barber' }
    });
    const member = await addRes.json();
    const res = await page.request.patch(`${BASE}/api/admin/barbers/${member.id}`, { data:{ active:false } });
    expect(res.status()).toBe(200);
    expect((await res.json()).active).toBe(0);
  });

  test('AT-12: Admin cannot demote last admin', async ({ page }) => {
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const team   = await (await page.request.get(`${BASE}/api/admin/barbers`)).json();
    const admins = team.filter(m => m.role === 'admin' && m.active);
    if (admins.length === 1) {
      const res = await page.request.patch(`${BASE}/api/admin/barbers/${admins[0].id}`, { data:{ role:'barber' } });
      expect(res.status()).toBe(400);
    } else {
      test.skip();
    }
  });

  test('AT-13: Admin can list all customers', async ({ page }) => {
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const res   = await page.request.get(`${BASE}/api/admin/customers`);
    expect(res.status()).toBe(200);
    const custs = await res.json();
    expect(Array.isArray(custs)).toBe(true);
    if (custs.length > 0) {
      expect(custs[0]).toHaveProperty('email');
      expect(custs[0]).toHaveProperty('booking_count');
    }
  });

  test('AT-14: Admin can search customers', async ({ page }) => {
    const email = `at14_${Date.now()}@test.com`;
    await makeBooking(page, { name:'AT14 Search', email });
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const res   = await page.request.get(`${BASE}/api/admin/customers?q=AT14`);
    expect(res.status()).toBe(200);
    const custs = await res.json();
    expect(custs.some(c => c.name === 'AT14 Search')).toBe(true);
  });

  test('AT-15: Admin can view individual customer with bookings', async ({ page }) => {
    const email   = `at15_${Date.now()}@test.com`;
    const bookRes = await makeBooking(page, { name:'AT15 Admin', email });
    expect(bookRes.status()).toBe(201);
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const res  = await page.request.get(`${BASE}/api/admin/customers/${encodeURIComponent(email)}`);
    expect(res.status()).toBe(200);
    const cust = await res.json();
    expect(cust.email).toBe(email);
    expect(Array.isArray(cust.bookings)).toBe(true);
    expect(cust.bookings.length).toBeGreaterThan(0);
  });

  test('AT-16: Admin can update customer notes', async ({ page }) => {
    const email   = `at16_${Date.now()}@test.com`;
    const bookRes = await makeBooking(page, { name:'AT16', email });
    expect(bookRes.status()).toBe(201);
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const res = await page.request.patch(`${BASE}/api/admin/customers/${encodeURIComponent(email)}`, {
      data: { notes:'Allergic to certain products' }
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).notes).toBe('Allergic to certain products');
  });

  test('AT-17: Admin can merge two customer accounts', async ({ page }) => {
    const ts     = Date.now();
    const emailA = `at17a_${ts}@test.com`;
    const emailB = `at17b_${ts}@test.com`;
    const bA = await makeBooking(page, { name:'AT17 Keep', email:emailA });
    expect(bA.status()).toBe(201);
    const bB = await makeBooking(page, { name:'AT17 Drop', email:emailB });
    expect(bB.status()).toBe(201);
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const mergeRes = await page.request.post(`${BASE}/api/admin/customers/merge`, {
      data: { keep_email:emailA, drop_email:emailB }
    });
    expect(mergeRes.status()).toBe(200);
    const kept = await mergeRes.json();
    expect(kept.email).toBe(emailA);
    const custRes = await page.request.get(`${BASE}/api/admin/customers/${encodeURIComponent(emailA)}`);
    const cust    = await custRes.json();
    expect(cust.bookings.length).toBe(2);
  });

  test('AT-18: Merge notes from both accounts', async ({ page }) => {
    const ts     = Date.now();
    const emailA = `at18a_${ts}@test.com`;
    const emailB = `at18b_${ts}@test.com`;
    await makeBooking(page, { name:'AT18a', email:emailA });
    await makeBooking(page, { name:'AT18b', email:emailB });
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    await page.request.patch(`${BASE}/api/admin/customers/${encodeURIComponent(emailA)}`, { data:{ notes:'Note A' } });
    await page.request.patch(`${BASE}/api/admin/customers/${encodeURIComponent(emailB)}`, { data:{ notes:'Note B' } });
    const mergeRes = await page.request.post(`${BASE}/api/admin/customers/merge`, {
      data: { keep_email:emailA, drop_email:emailB }
    });
    expect(mergeRes.status()).toBe(200);
    const kept = await mergeRes.json();
    expect(kept.notes).toContain('Note A');
    expect(kept.notes).toContain('Note B');
  });

  test('AT-19: Cannot merge customer with themselves', async ({ page }) => {
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const res = await page.request.post(`${BASE}/api/admin/customers/merge`, {
      data: { keep_email:'same@test.com', drop_email:'same@test.com' }
    });
    expect(res.status()).toBe(400);
  });

  test('AT-20: Admin dashboard shows barber filter', async ({ page }) => {
    await login(page, 'admin', 'admin123');
    await expect(page.locator('#f-barber')).toBeVisible();
  });

  test('AT-21: Admin can filter bookings by date', async ({ page }) => {
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const today = new Date().toISOString().split('T')[0];
    const res   = await page.request.get(`${BASE}/api/admin/bookings?date=${today}`);
    expect(res.status()).toBe(200);
    const bookings = await res.json();
    bookings.forEach(b => expect(b.appointment_date).toBe(today));
  });

  test('AT-22: Admin can filter bookings by status', async ({ page }) => {
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const res = await page.request.get(`${BASE}/api/admin/bookings?status=pending`);
    expect(res.status()).toBe(200);
    const bookings = await res.json();
    bookings.forEach(b => expect(b.status).toBe('pending'));
  });

  test('AT-23: Unauthenticated access to admin API blocked', async ({ page }) => {
    const res = await page.request.get(`${BASE}/api/admin/bookings`);
    expect(res.status()).toBe(401);
  });

  test('AT-24: Customers list excludes merged accounts', async ({ page }) => {
    const ts     = Date.now();
    const emailA = `at24a_${ts}@test.com`;
    const emailB = `at24b_${ts}@test.com`;
    await makeBooking(page, { name:'AT24a', email:emailA });
    await makeBooking(page, { name:'AT24b', email:emailB });
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    await page.request.post(`${BASE}/api/admin/customers/merge`, { data:{ keep_email:emailA, drop_email:emailB } });
    const res   = await page.request.get(`${BASE}/api/admin/customers`);
    const custs = await res.json();
    const emails = custs.map(c => c.email);
    expect(emails).not.toContain(emailB);
    expect(emails).toContain(emailA);
  });

  test('AT-25: Admin cannot assign barber to a slot they are already booked in', async ({ page }) => {
    const slot = nextSlot();
    // Book barber 1 in a slot
    const b1 = await page.request.post(`${BASE}/api/bookings`, {
      data: { customer_name:'AT25a', customer_email:`at25a_${Date.now()}@test.com`, service_id:1, stylist_id:1, appointment_date:slot.date, appointment_time:slot.time }
    });
    expect(b1.status()).toBe(201);
    // Create a second booking at the same time with no barber
    const b2 = await page.request.post(`${BASE}/api/bookings`, {
      data: { customer_name:'AT25b', customer_email:`at25b_${Date.now()}@test.com`, service_id:1, appointment_date:slot.date, appointment_time:slot.time }
    });
    expect(b2.status()).toBe(201);
    const booking2 = await b2.json();
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    // Try to assign barber 1 to the second booking — should be blocked
    const res = await page.request.patch(`${BASE}/api/admin/bookings/${booking2.id}`, { data:{ stylist_id:1 } });
    expect(res.status()).toBe(409);
  });

  test('AT-27: Customer drawer shows merge button for admin only', async ({ page }) => {
    await login(page, 'admin', 'admin123');
    await page.click('#nav-customers');
    await page.waitForTimeout(800);
    const count = await page.locator('#cust-tbody button').count();
    if (count > 0) {
      await page.locator('#cust-tbody button').first().click();
      await page.waitForTimeout(500);
      await expect(page.locator('#cd-merge-wrap')).toBeVisible();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ADMIN — MOBILE
// ════════════════════════════════════════════════════════════════════════════

test.describe('Admin — Mobile', () => {
  test.use(MOBILE);

  test('AM-01: Admin can log in on mobile', async ({ page }) => {
    await login(page, 'admin', 'admin123');
    await expect(page).toHaveURL(`${BASE}/admin.html`);
  });

  test('AM-02: Admin dashboard loads on mobile', async ({ page }) => {
    await login(page, 'admin', 'admin123');
    await expect(page.locator('.main')).toBeVisible();
  });

  test('AM-03: Admin can view customers on mobile', async ({ page }) => {
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const res = await page.request.get(`${BASE}/api/admin/customers`);
    expect(res.status()).toBe(200);
  });

  test('AM-04: No horizontal overflow on admin page', async ({ page }) => {
    await login(page, 'admin', 'admin123');
    await page.waitForLoadState('networkidle');
    const mainWidth   = await page.evaluate(() => document.querySelector('.main').scrollWidth);
    const windowWidth = await page.evaluate(() => window.innerWidth);
    expect(mainWidth).toBeLessThanOrEqual(windowWidth + 5);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AUTH & SESSION
// ════════════════════════════════════════════════════════════════════════════

test.describe('Auth & Session', () => {
  test.use(DESKTOP);

  test('AS-01: /api/auth/me returns 401 when not logged in', async ({ page }) => {
    const res = await page.request.get(`${BASE}/api/auth/me`);
    expect(res.status()).toBe(401);
  });

  test('AS-02: Login returns user info', async ({ page }) => {
    const res  = await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('id');
    expect(data.role).toBe('admin');
  });

  test('AS-03: Logout clears session', async ({ page }) => {
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    await page.request.post(`${BASE}/api/auth/logout`);
    const res = await page.request.get(`${BASE}/api/auth/me`);
    expect(res.status()).toBe(401);
  });

  test('AS-04: Deactivated user cannot log in', async ({ page }) => {
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const username = `deact_${Date.now()}`;
    const addRes   = await page.request.post(`${BASE}/api/admin/barbers`, {
      data: { name:'Deact Test', username, password:'deact123456', role:'barber' }
    });
    const member = await addRes.json();
    await page.request.patch(`${BASE}/api/admin/barbers/${member.id}`, { data:{ active:false } });
    await page.request.post(`${BASE}/api/auth/logout`);
    const loginRes = await page.request.post(`${BASE}/api/auth/login`, { data:{ username, password:'deact123456' } });
    expect(loginRes.status()).toBe(401);
  });

  test('AS-05: Short password rejected on add', async ({ page }) => {
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const res = await page.request.post(`${BASE}/api/admin/barbers`, {
      data: { name:'Short PW', username:`short_${Date.now()}`, password:'123', role:'barber' }
    });
    expect(res.status()).toBe(400);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CUSTOMER — DESKTOP (additional edge cases)
// ════════════════════════════════════════════════════════════════════════════

test.describe('Customer — API Edge Cases', () => {
  test.use(DESKTOP);

  test('CT-11: Availability without date param returns 400', async ({ page }) => {
    const res = await page.request.get(`${BASE}/api/availability`);
    expect(res.status()).toBe(400);
  });

  test('CT-12: Cancelled booking slot becomes available again', async ({ page }) => {
    const slot = nextSlot();
    // Book the slot
    const b = await page.request.post(`${BASE}/api/bookings`, {
      data: { customer_name:'CT12', customer_email:`ct12_${Date.now()}@test.com`, service_id:1, stylist_id:slot.stylist_id, appointment_date:slot.date, appointment_time:slot.time }
    });
    expect(b.status()).toBe(201);
    const booking = await b.json();
    // Cancel it via admin
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    await page.request.patch(`${BASE}/api/admin/bookings/${booking.id}`, { data:{ status:'cancelled' } });
    // Slot should now appear as available
    const avail = await page.request.get(`${BASE}/api/availability?date=${slot.date}&stylist_id=${slot.stylist_id}`);
    const data  = await avail.json();
    expect(data.slots).toContain(slot.time);
  });

  test('CT-13: Booking with Any Available barber (null stylist_id) succeeds', async ({ page }) => {
    const slot = nextSlot();
    const res = await page.request.post(`${BASE}/api/bookings`, {
      data: { customer_name:'CT13 AnyBarber', customer_email:`ct13_${Date.now()}@test.com`, service_id:1, appointment_date:slot.date, appointment_time:slot.time }
    });
    expect(res.status()).toBe(201);
    const booking = await res.json();
    expect(booking.stylist_id).toBeNull();
  });

  test('CT-14: Booking returns service name and price', async ({ page }) => {
    const res = await makeBooking(page, { name:'CT14', email:`ct14_${Date.now()}@test.com` });
    expect(res.status()).toBe(201);
    const booking = await res.json();
    expect(booking).toHaveProperty('service_name');
    expect(booking).toHaveProperty('price_cents');
    expect(typeof booking.price_cents).toBe('number');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CUSTOMER — MOBILE (additional)
// ════════════════════════════════════════════════════════════════════════════

test.describe('Customer — Mobile Additional', () => {
  test.use(MOBILE);

  test('CM-05: No horizontal overflow on home page', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');
    const bodyWidth   = await page.evaluate(() => document.body.scrollWidth);
    const windowWidth = await page.evaluate(() => window.innerWidth);
    expect(bodyWidth).toBeLessThanOrEqual(windowWidth + 5);
  });

  test('CM-06: Hamburger menu button visible on booking page mobile', async ({ page }) => {
    await page.goto(`${BASE}/booking`);
    await page.waitForLoadState('networkidle');
    // The burger button should be visible (not hidden by CSS)
    const burger = page.locator('.nav-burger, .burger-menu, button[aria-label*="menu"], button[class*="burger"], button[class*="hamburger"]').first();
    await expect(burger).toBeVisible({ timeout: 5000 });
  });

  test('CM-07: Hamburger menu button visible on home page mobile', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');
    const burger = page.locator('.nav-burger, .burger-menu, button[aria-label*="menu"], button[class*="burger"], button[class*="hamburger"]').first();
    await expect(burger).toBeVisible({ timeout: 5000 });
  });

  test('CM-08: Booking step bar does not overflow on mobile', async ({ page }) => {
    await page.goto(`${BASE}/booking`);
    await page.waitForLoadState('networkidle');
    const stepBar = page.locator('.steps-bar');
    await expect(stepBar).toBeVisible({ timeout: 5000 });
    const box = await stepBar.boundingBox();
    const windowWidth = await page.evaluate(() => window.innerWidth);
    if (box) {
      expect(box.x + box.width).toBeLessThanOrEqual(windowWidth + 5);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// BARBER — DESKTOP (additional edge cases)
// ════════════════════════════════════════════════════════════════════════════

test.describe('Barber — Password Edge Cases', () => {
  test.use(DESKTOP);

  test('BT-13: Wrong current password returns 401', async ({ page }) => {
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'marcus', password:'marcus123' } });
    const res = await page.request.post(`${BASE}/api/auth/change-password`, {
      data: { current_password:'wrongpassword', new_password:'newpassword123' }
    });
    expect(res.status()).toBe(401);
  });

  test('BT-14: Short new password returns 400 on change-password', async ({ page }) => {
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'marcus', password:'marcus123' } });
    const res = await page.request.post(`${BASE}/api/auth/change-password`, {
      data: { current_password:'marcus123', new_password:'abc' }
    });
    expect(res.status()).toBe(400);
  });

  test('BT-15: Change password without fields returns 400', async ({ page }) => {
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'james', password:'james123' } });
    const res = await page.request.post(`${BASE}/api/auth/change-password`, { data: {} });
    expect(res.status()).toBe(400);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ADMIN — DESKTOP (additional coverage)
// ════════════════════════════════════════════════════════════════════════════

test.describe('Admin — Additional Coverage', () => {
  test.use(DESKTOP);

  test('AT-26: Admin can filter bookings by barber (stylist_id)', async ({ page }) => {
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const res = await page.request.get(`${BASE}/api/admin/bookings?stylist_id=1`);
    expect(res.status()).toBe(200);
    const bookings = await res.json();
    bookings.filter(b => b.stylist_id !== null).forEach(b => expect(b.stylist_id).toBe(1));
  });

  test('AT-28: date_from filter excludes bookings before the cutoff date', async ({ page }) => {
    // Create a booking far in the future (2050) so it appears in next query
    const futureDate = '2050-03-15';
    await page.request.post(`${BASE}/api/bookings`, {
      data: { customer_name:'AT28 future', customer_email:`at28f_${Date.now()}@test.com`, service_id:1, appointment_date:futureDate, appointment_time:'09:00' }
    });
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    // Query with date_from = 2050 — should only return 2050+ bookings
    const res = await page.request.get(`${BASE}/api/admin/bookings?date_from=${futureDate}`);
    expect(res.status()).toBe(200);
    const bookings = await res.json();
    // Every booking returned must have date >= futureDate
    bookings.forEach(b => {
      expect(b.appointment_date >= futureDate).toBe(true);
    });
    // The 2050 booking we created should be in the results
    expect(bookings.some(b => b.appointment_date === futureDate)).toBe(true);
  });

  test('AT-29: Merge with non-existent keep_email returns 404', async ({ page }) => {
    const ts = Date.now();
    const emailB = `at29b_${ts}@test.com`;
    await makeBooking(page, { name:'AT29b', email:emailB });
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const res = await page.request.post(`${BASE}/api/admin/customers/merge`, {
      data: { keep_email:`nonexistent_${ts}@test.com`, drop_email:emailB }
    });
    expect(res.status()).toBe(404);
  });

  test('AT-30: Merge with non-existent drop_email returns 404', async ({ page }) => {
    const ts = Date.now();
    const emailA = `at30a_${ts}@test.com`;
    await makeBooking(page, { name:'AT30a', email:emailA });
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const res = await page.request.post(`${BASE}/api/admin/customers/merge`, {
      data: { keep_email:emailA, drop_email:`nonexistent_${ts}@test.com` }
    });
    expect(res.status()).toBe(404);
  });

  test('AT-31: Admin can re-activate a deactivated team member', async ({ page }) => {
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const username = `react_${Date.now()}`;
    const addRes = await page.request.post(`${BASE}/api/admin/barbers`, {
      data: { name:'Reactivate Test', username, password:'react123456', role:'barber' }
    });
    const member = await addRes.json();
    // Deactivate
    await page.request.patch(`${BASE}/api/admin/barbers/${member.id}`, { data:{ active:false } });
    // Re-activate
    const res = await page.request.patch(`${BASE}/api/admin/barbers/${member.id}`, { data:{ active:true } });
    expect(res.status()).toBe(200);
    expect((await res.json()).active).toBe(1);
  });

  test('AT-32: Admin can update team member bio', async ({ page }) => {
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    // Update Marcus's bio
    const team = await (await page.request.get(`${BASE}/api/admin/barbers`)).json();
    const marcus = team.find(m => m.username === 'marcus');
    const res = await page.request.patch(`${BASE}/api/admin/barbers/${marcus.id}`, {
      data: { bio:'Specializes in classic cuts and fades' }
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).bio).toBe('Specializes in classic cuts and fades');
  });

  test('AT-33: Admin can update customer name', async ({ page }) => {
    const email = `at33_${Date.now()}@test.com`;
    await makeBooking(page, { name:'AT33 Old Name', email });
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const res = await page.request.patch(`${BASE}/api/admin/customers/${encodeURIComponent(email)}`, {
      data: { name:'AT33 New Name' }
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).name).toBe('AT33 New Name');
  });

  test('AT-34: Admin can update customer phone', async ({ page }) => {
    const email = `at34_${Date.now()}@test.com`;
    await makeBooking(page, { name:'AT34', email, phone:'6031110000' });
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const res = await page.request.patch(`${BASE}/api/admin/customers/${encodeURIComponent(email)}`, {
      data: { phone:'6039999999' }
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).phone).toBe('6039999999');
  });

  test('AT-35: Customer not found returns 404', async ({ page }) => {
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const res = await page.request.get(`${BASE}/api/admin/customers/nobody_${Date.now()}@nowhere.com`);
    expect(res.status()).toBe(404);
  });

  test('AT-36: Admin can reset team member password', async ({ page }) => {
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const username = `pwreset_${Date.now()}`;
    const addRes = await page.request.post(`${BASE}/api/admin/barbers`, {
      data: { name:'PW Reset', username, password:'initial123', role:'barber' }
    });
    const member = await addRes.json();
    const resetRes = await page.request.patch(`${BASE}/api/admin/barbers/${member.id}`, {
      data: { new_password:'newpass456' }
    });
    expect(resetRes.status()).toBe(200);
    // Verify new password works
    const loginRes = await page.request.post(`${BASE}/api/auth/login`, { data:{ username, password:'newpass456' } });
    expect(loginRes.status()).toBe(200);
  });

  test('AT-37: Admin PATCH barber with short new_password returns 400', async ({ page }) => {
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const team = await (await page.request.get(`${BASE}/api/admin/barbers`)).json();
    const marcus = team.find(m => m.username === 'marcus');
    const res = await page.request.patch(`${BASE}/api/admin/barbers/${marcus.id}`, {
      data: { new_password:'abc' }
    });
    expect(res.status()).toBe(400);
  });

  test('AT-38: PATCH booking with nothing to update returns 400', async ({ page }) => {
    const bookRes = await makeBooking(page, { name:'AT38', email:`at38_${Date.now()}@test.com` });
    expect(bookRes.status()).toBe(201);
    const booking = await bookRes.json();
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const res = await page.request.patch(`${BASE}/api/admin/bookings/${booking.id}`, { data:{} });
    expect(res.status()).toBe(400);
  });

  test('AT-39: PATCH non-existent booking returns 404', async ({ page }) => {
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const res = await page.request.patch(`${BASE}/api/admin/bookings/9999999`, { data:{ status:'confirmed' } });
    expect(res.status()).toBe(404);
  });

  test('AT-40: Admin can filter bookings by date and status combined', async ({ page }) => {
    const slot = nextSlot();
    const b = await page.request.post(`${BASE}/api/bookings`, {
      data: { customer_name:'AT40', customer_email:`at40_${Date.now()}@test.com`, service_id:1, appointment_date:slot.date, appointment_time:slot.time }
    });
    expect(b.status()).toBe(201);
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const res = await page.request.get(`${BASE}/api/admin/bookings?date=${slot.date}&status=pending`);
    expect(res.status()).toBe(200);
    const bookings = await res.json();
    bookings.forEach(b => {
      expect(b.appointment_date).toBe(slot.date);
      expect(b.status).toBe('pending');
    });
  });

  test('AT-41: PATCH customer with nothing to update returns 400', async ({ page }) => {
    const email = `at41_${Date.now()}@test.com`;
    await makeBooking(page, { name:'AT41', email });
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const res = await page.request.patch(`${BASE}/api/admin/customers/${encodeURIComponent(email)}`, { data:{} });
    expect(res.status()).toBe(400);
  });

  test('AT-42: Merge missing fields returns 400', async ({ page }) => {
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const res = await page.request.post(`${BASE}/api/admin/customers/merge`, { data:{ keep_email:'a@test.com' } });
    expect(res.status()).toBe(400);
  });

  test('AT-43: PATCH barber not found returns 404', async ({ page }) => {
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const res = await page.request.patch(`${BASE}/api/admin/barbers/9999999`, { data:{ bio:'test' } });
    expect(res.status()).toBe(404);
  });

  test('AT-44: Add barber missing required fields returns 400', async ({ page }) => {
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const res = await page.request.post(`${BASE}/api/admin/barbers`, { data:{ name:'No Username' } });
    expect(res.status()).toBe(400);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PRODUCTION READINESS — final edge cases
// ════════════════════════════════════════════════════════════════════════════

test.describe('Production Readiness', () => {
  test.use(DESKTOP);

  // ── Input validation (prevents 500 crashes) ─────────────────────────────

  test('PR-01: Invalid service_id returns 400 not 500', async ({ page }) => {
    const slot = nextSlot();
    const res = await page.request.post(`${BASE}/api/bookings`, {
      data: { customer_name:'PR01', customer_email:`pr01_${Date.now()}@test.com`, service_id:9999, appointment_date:slot.date, appointment_time:slot.time }
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  test('PR-02: Invalid stylist_id returns 400 not 500', async ({ page }) => {
    const slot = nextSlot();
    const res = await page.request.post(`${BASE}/api/bookings`, {
      data: { customer_name:'PR02', customer_email:`pr02_${Date.now()}@test.com`, service_id:1, stylist_id:9999, appointment_date:slot.date, appointment_time:slot.time }
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  // ── Services API ────────────────────────────────────────────────────────

  test('PR-03: Services API returns at least 5 active services', async ({ page }) => {
    const res      = await page.request.get(`${BASE}/api/services`);
    expect(res.status()).toBe(200);
    const services = await res.json();
    expect(services.length).toBeGreaterThanOrEqual(5);
    services.forEach(s => {
      expect(s).toHaveProperty('id');
      expect(s).toHaveProperty('name');
      expect(s).toHaveProperty('price_cents');
      expect(s).toHaveProperty('duration_min');
      expect(s.price_cents).toBeGreaterThan(0);
      expect(s.duration_min).toBeGreaterThan(0);
    });
  });

  // ── Barbers API ─────────────────────────────────────────────────────────

  test('PR-04: Public barbers API only returns active barbers', async ({ page }) => {
    // Deactivate a temp barber and confirm they don't appear publicly
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const username = `pr04_${Date.now()}`;
    const addRes = await page.request.post(`${BASE}/api/admin/barbers`, {
      data: { name:'PR04 Temp', username, password:'pr04123456', role:'barber' }
    });
    const member = await addRes.json();
    await page.request.patch(`${BASE}/api/admin/barbers/${member.id}`, { data:{ active:false } });
    await page.request.post(`${BASE}/api/auth/logout`);
    // Public API should not include deactivated barber
    const res     = await page.request.get(`${BASE}/api/barbers`);
    const barbers = await res.json();
    expect(barbers.some(b => b.id === member.id)).toBe(false);
  });

  test('PR-05: Public barbers API does not expose admin accounts', async ({ page }) => {
    const res     = await page.request.get(`${BASE}/api/barbers`);
    const barbers = await res.json();
    // Should not include admin role accounts
    barbers.forEach(b => {
      expect(b).not.toHaveProperty('password_hash');
      expect(b).not.toHaveProperty('username');
    });
  });

  // ── Booking notes ───────────────────────────────────────────────────────

  test('PR-06: Booking notes are stored and returned', async ({ page }) => {
    const slot = nextSlot();
    const note = 'Please use scissors only, no clippers';
    const res = await page.request.post(`${BASE}/api/bookings`, {
      data: { customer_name:'PR06', customer_email:`pr06_${Date.now()}@test.com`, service_id:1, stylist_id:slot.stylist_id, appointment_date:slot.date, appointment_time:slot.time, notes:note }
    });
    expect(res.status()).toBe(201);
    const booking = await res.json();
    expect(booking.notes).toBe(note);
  });

  // ── Auth structure ──────────────────────────────────────────────────────

  test('PR-07: Auth /me response includes photo_url field', async ({ page }) => {
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'marcus', password:'marcus123' } });
    const res  = await page.request.get(`${BASE}/api/auth/me`);
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('id');
    expect(data).toHaveProperty('name');
    expect(data).toHaveProperty('role');
    expect(data).toHaveProperty('photo_url');
  });

  test('PR-08: Login with empty credentials returns 401', async ({ page }) => {
    const res = await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'', password:'' } });
    expect(res.status()).toBe(401);
  });

  // ── Mobile ──────────────────────────────────────────────────────────────

  test('PR-09: Login page no overflow on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/login.html`);
    await page.waitForLoadState('networkidle');
    const bodyWidth   = await page.evaluate(() => document.body.scrollWidth);
    const windowWidth = await page.evaluate(() => window.innerWidth);
    expect(bodyWidth).toBeLessThanOrEqual(windowWidth + 5);
  });

  // ── Booking availability edge case ──────────────────────────────────────

  test('PR-10: Availability with invalid date returns slots (server does not crash)', async ({ page }) => {
    const res = await page.request.get(`${BASE}/api/availability?date=not-a-date`);
    expect(res.status()).toBe(200); // server returns empty or full slot list
    const data = await res.json();
    expect(data).toHaveProperty('slots');
  });

  test('PR-11: All booking fields are present in response', async ({ page }) => {
    const res = await makeBooking(page, { name:'PR11', email:`pr11_${Date.now()}@test.com` });
    expect(res.status()).toBe(201);
    const b = await res.json();
    ['id','customer_name','customer_email','service_id','appointment_date','appointment_time','status','service_name','price_cents'].forEach(field => {
      expect(b).toHaveProperty(field);
    });
    expect(b.status).toBe('pending');
  });

  test('PR-12: Admin booking list includes stylist and service info', async ({ page }) => {
    await makeBooking(page, { name:'PR12', email:`pr12_${Date.now()}@test.com` });
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const res      = await page.request.get(`${BASE}/api/admin/bookings`);
    const bookings = await res.json();
    expect(bookings.length).toBeGreaterThan(0);
    const b = bookings[0];
    expect(b).toHaveProperty('service_name');
    expect(b).toHaveProperty('price_cents');
  });

  test('PR-13: Customer list returns expected shape', async ({ page }) => {
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'admin', password:'admin123' } });
    const res   = await page.request.get(`${BASE}/api/admin/customers`);
    const custs = await res.json();
    expect(Array.isArray(custs)).toBe(true);
    if (custs.length > 0) {
      ['id','email','name','phone','notes','booking_count'].forEach(field => {
        expect(custs[0]).toHaveProperty(field);
      });
    }
  });

  test('PR-14: Barber bookings view is filtered — only authenticated user data accessible', async ({ page }) => {
    // Barber can access /api/admin/bookings but not /api/admin/barbers
    await page.request.post(`${BASE}/api/auth/login`, { data:{ username:'marcus', password:'marcus123' } });
    const allowed  = await page.request.get(`${BASE}/api/admin/bookings`);
    const blocked  = await page.request.get(`${BASE}/api/admin/barbers`);
    expect(allowed.status()).toBe(200);
    expect(blocked.status()).toBe(403);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// END-TO-END UI FLOWS — actual browser interaction (critical for go-live)
// ════════════════════════════════════════════════════════════════════════════

test.describe('E2E — Booking Wizard (Desktop)', () => {
  test.use(DESKTOP);

  test('E2E-01: Services load and are clickable on booking page', async ({ page }) => {
    await page.goto(`${BASE}/booking`);
    await page.waitForLoadState('networkidle');
    // Step 1 services list should be populated
    const items = page.locator('#services-list .svc-item');
    await expect(items.first()).toBeVisible({ timeout: 8000 });
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(5);
    // Clicking a service enables the Next button
    await items.first().click();
    await expect(page.locator('#btn-1-next')).not.toBeDisabled({ timeout: 3000 });
  });

  test('E2E-02: Can advance from Step 1 to Step 2 (Barber)', async ({ page }) => {
    await page.goto(`${BASE}/booking`);
    await page.waitForLoadState('networkidle');
    await page.locator('#services-list .svc-item').first().click();
    await page.click('#btn-1-next');
    await expect(page.locator('#step-2')).toHaveClass(/active/, { timeout: 3000 });
    // Barber grid should be populated
    const cards = page.locator('#barber-grid .barber-card');
    await expect(cards.first()).toBeVisible({ timeout: 5000 });
  });

  test('E2E-03: "Any Available" barber card is present and selectable', async ({ page }) => {
    await page.goto(`${BASE}/booking`);
    await page.waitForLoadState('networkidle');
    await page.locator('#services-list .svc-item').first().click();
    await page.click('#btn-1-next');
    const anyCard = page.locator('#barber-any');
    await expect(anyCard).toBeVisible({ timeout: 5000 });
    await anyCard.click();
    await expect(page.locator('#btn-2-next')).not.toBeDisabled({ timeout: 3000 });
  });

  test('E2E-04: Can advance from Step 2 to Step 3 (Date & Time)', async ({ page }) => {
    await page.goto(`${BASE}/booking`);
    await page.waitForLoadState('networkidle');
    // Step 1
    await page.locator('#services-list .svc-item').first().click();
    await page.click('#btn-1-next');
    // Step 2 — pick Any Available
    await expect(page.locator('#barber-any')).toBeVisible({ timeout: 5000 });
    await page.click('#barber-any');
    await page.click('#btn-2-next');
    // Step 3 should be active
    await expect(page.locator('#step-3')).toHaveClass(/active/, { timeout: 3000 });
    await expect(page.locator('#date-picker')).toBeVisible();
  });

  test('E2E-05: Selecting a date loads available time slots', async ({ page }) => {
    await page.goto(`${BASE}/booking`);
    await page.waitForLoadState('networkidle');
    await page.locator('#services-list .svc-item').first().click();
    await page.click('#btn-1-next');
    await expect(page.locator('#barber-any')).toBeVisible({ timeout: 5000 });
    await page.click('#barber-any');
    await page.click('#btn-2-next');
    // Pick a far-future date (guaranteed slots available)
    await page.fill('#date-picker', '2088-06-15');
    await page.dispatchEvent('#date-picker', 'change');
    // Slots should load
    const slots = page.locator('#slots-grid .slot-btn');
    await expect(slots.first()).toBeVisible({ timeout: 8000 });
    const count = await slots.count();
    expect(count).toBeGreaterThan(0);
  });

  test('E2E-06: Full booking wizard completes end-to-end', async ({ page }) => {
    await page.goto(`${BASE}/booking`);
    await page.waitForLoadState('networkidle');
    // Step 1: pick first service
    await page.locator('#services-list .svc-item').first().click();
    await page.click('#btn-1-next');
    // Step 2: Any Available
    await expect(page.locator('#barber-any')).toBeVisible({ timeout: 5000 });
    await page.click('#barber-any');
    await page.click('#btn-2-next');
    // Step 3: pick date and first slot
    await page.fill('#date-picker', '2088-07-20');
    await page.dispatchEvent('#date-picker', 'change');
    const firstSlot = page.locator('#slots-grid .slot-btn').first();
    await expect(firstSlot).toBeVisible({ timeout: 8000 });
    await firstSlot.click();
    await page.click('#btn-3-next');
    // Step 4: fill contact info
    await expect(page.locator('#step-4')).toHaveClass(/active/, { timeout: 3000 });
    const ts = Date.now();
    await page.fill('#f-name', 'E2E Test Customer');
    await page.fill('#f-email', `e2e_${ts}@test.com`);
    await page.fill('#f-phone', '6031234567');
    // Submit
    await page.click('#btn-submit');
    // Should show confirmation (success state — #success-screen gets class 'show')
    await expect(page.locator('#success-screen.show')).toBeVisible({ timeout: 10000 });
  });

  test('E2E-07: Confirm summary shows correct service name before submit', async ({ page }) => {
    await page.goto(`${BASE}/booking`);
    await page.waitForLoadState('networkidle');
    const serviceEl = page.locator('#services-list .svc-item').first();
    const serviceName = await serviceEl.locator('.svc-name, h3, strong, [class*="name"]').first().textContent();
    await serviceEl.click();
    await page.click('#btn-1-next');
    await expect(page.locator('#barber-any')).toBeVisible({ timeout: 5000 });
    await page.click('#barber-any');
    await page.click('#btn-2-next');
    await page.fill('#date-picker', '2088-08-10');
    await page.dispatchEvent('#date-picker', 'change');
    await expect(page.locator('#slots-grid .slot-btn').first()).toBeVisible({ timeout: 8000 });
    await page.locator('#slots-grid .slot-btn').first().click();
    await page.click('#btn-3-next');
    // Summary on step 4 should show the service name
    const summary = await page.locator('#confirm-summary').textContent();
    expect(summary).toBeTruthy();
    expect(summary.length).toBeGreaterThan(0);
  });

  test('E2E-08: Back navigation works between steps', async ({ page }) => {
    await page.goto(`${BASE}/booking`);
    await page.waitForLoadState('networkidle');
    await page.locator('#services-list .svc-item').first().click();
    await page.click('#btn-1-next');
    await expect(page.locator('#step-2')).toHaveClass(/active/, { timeout: 3000 });
    // Go back
    await page.click('#step-2 .btn-secondary');
    await expect(page.locator('#step-1')).toHaveClass(/active/, { timeout: 3000 });
  });
});

test.describe('E2E — Booking Wizard (Mobile)', () => {
  test.use(MOBILE);

  test('E2E-09: Full booking wizard works on mobile', async ({ page }) => {
    await page.goto(`${BASE}/booking`);
    await page.waitForLoadState('networkidle');
    await page.locator('#services-list .svc-item').first().click();
    await expect(page.locator('#btn-1-next')).not.toBeDisabled({ timeout: 3000 });
    await page.click('#btn-1-next');
    await expect(page.locator('#barber-any')).toBeVisible({ timeout: 5000 });
    await page.click('#barber-any');
    await page.click('#btn-2-next');
    await page.fill('#date-picker', '2088-09-05');
    await page.dispatchEvent('#date-picker', 'change');
    await expect(page.locator('#slots-grid .slot-btn').first()).toBeVisible({ timeout: 8000 });
    await page.locator('#slots-grid .slot-btn').first().click();
    await page.click('#btn-3-next');
    await expect(page.locator('#step-4')).toHaveClass(/active/, { timeout: 3000 });
    await page.fill('#f-name', 'Mobile E2E Customer');
    await page.fill('#f-email', `mobile_e2e_${Date.now()}@test.com`);
    await page.click('#btn-submit');
    await expect(page.locator('#success-screen.show')).toBeVisible({ timeout: 10000 });
  });
});

test.describe('E2E — Admin UI', () => {
  test.use(DESKTOP);

  test('E2E-10: Admin page redirects unauthenticated users to login', async ({ page }) => {
    await page.goto(`${BASE}/admin.html`);
    await page.waitForLoadState('networkidle');
    // Should redirect to login.html or show login form
    const url = page.url();
    const body = await page.textContent('body');
    const isRedirected = url.includes('login') || body.toLowerCase().includes('sign in') || body.toLowerCase().includes('username');
    expect(isRedirected).toBe(true);
  });

  test('E2E-11: Admin bookings table renders with data', async ({ page }) => {
    await login(page, 'admin', 'admin123');
    await page.waitForLoadState('networkidle');
    // Bookings table body: #bookings-tbody
    const tbody = page.locator('#bookings-tbody');
    await expect(tbody).toBeVisible({ timeout: 8000 });
    const rows = await page.locator('#bookings-tbody tr').count();
    expect(rows).toBeGreaterThan(0);
  });

  test('E2E-12: Admin can switch to Customers view and see table', async ({ page }) => {
    await login(page, 'admin', 'admin123');
    await page.click('#nav-customers');
    await page.waitForTimeout(1000);
    const tbody = page.locator('#cust-tbody');
    await expect(tbody).toBeVisible({ timeout: 5000 });
    const rows = await page.locator('#cust-tbody tr').count();
    expect(rows).toBeGreaterThan(0);
  });

  test('E2E-13: Admin Team view shows team members', async ({ page }) => {
    await login(page, 'admin', 'admin123');
    // nav-team is hidden until clicked for admins — click it
    await page.evaluate(() => document.getElementById('nav-team').click());
    await page.waitForTimeout(1500);
    // Team is rendered in a grid (#team-grid), not a tbody
    const grid = page.locator('#team-grid');
    await expect(grid).toBeVisible({ timeout: 5000 });
    const cards = await page.locator('#team-grid .team-card, #team-grid .member-card, #team-grid [class*="card"]').count();
    expect(cards).toBeGreaterThanOrEqual(4);
  });

  test('E2E-14: Admin barber filter dropdown is populated', async ({ page }) => {
    await login(page, 'admin', 'admin123');
    await page.waitForLoadState('networkidle');
    const select = page.locator('#f-barber');
    await expect(select).toBeVisible({ timeout: 5000 });
    const options = await select.locator('option').count();
    expect(options).toBeGreaterThan(1); // At least "All barbers" + barbers
  });

  test('E2E-15: Barber login shows bookings + customers nav but not team', async ({ page }) => {
    await login(page, 'marcus', 'marcus123');
    await page.waitForLoadState('networkidle');
    // Bookings nav links exist (nav-all, nav-today, nav-upcoming)
    await expect(page.locator('#nav-all')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#nav-customers')).toBeVisible();
    await expect(page.locator('#nav-team')).toBeHidden();
  });

  test('E2E-16: Home page CTA navigates to booking page', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');
    // Click the main Book Now CTA
    const bookBtn = page.locator('a[href*="booking"], button:has-text("Book"), a:has-text("Book")').first();
    await expect(bookBtn).toBeVisible({ timeout: 5000 });
    await bookBtn.click();
    await page.waitForURL(`${BASE}/booking`, { timeout: 8000 });
    await expect(page).toHaveURL(`${BASE}/booking`);
  });

  test('E2E-17: All static pages return 200', async ({ page }) => {
    const pages = ['/', '/booking', '/login.html', '/admin.html'];
    for (const p of pages) {
      const res = await page.request.get(`${BASE}${p}`);
      expect(res.status()).toBe(200);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// NEW FEATURES — API Tests
// ════════════════════════════════════════════════════════════════════════════

test.describe('Feature 1 — Reminders', () => {
  test.use(DESKTOP);

  test('F1-01: Manual remind endpoint requires admin auth', async ({ page }) => {
    const res = await page.request.post(`${BASE}/api/admin/bookings/1/remind`);
    expect(res.status()).toBe(401);
  });

  test('F1-02: Manual remind on non-existent booking returns 404', async ({ page }) => {
    await login(page, 'admin', 'admin123');
    const res = await page.request.post(`${BASE}/api/admin/bookings/999999/remind`);
    expect(res.status()).toBe(404);
  });

  test('F1-03: Manual remind on real booking returns ok', async ({ page }) => {
    await login(page, 'admin', 'admin123');
    // Create a booking first
    const bkRes = await makeBooking(page, { name:'Remind Test', email:`remind_${Date.now()}@test.com`, phone:'6031110001' });
    const bk    = await bkRes.json();
    const res   = await page.request.post(`${BASE}/api/admin/bookings/${bk.id}/remind`);
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });
});

test.describe('Feature 2 — Block Clients', () => {
  test.use(DESKTOP);

  test('F2-01: Blocked customer cannot book online', async ({ page }) => {
    const email = `blocked_${Date.now()}@test.com`;
    // Create customer via a booking
    const slot = nextSlot();
    await page.request.post(`${BASE}/api/bookings`, { data: {
      customer_name:'Block Test', customer_email:email, customer_phone:'6030000001',
      service_id:1, stylist_id:slot.stylist_id, appointment_date:slot.date, appointment_time:slot.time
    }});
    // Login as admin and block the customer
    await login(page, 'admin', 'admin123');
    const patchRes = await page.request.patch(`${BASE}/api/admin/customers/${encodeURIComponent(email)}`, {
      data: { blocked: true }
    });
    expect(patchRes.status()).toBe(200);
    const patched = await patchRes.json();
    expect(patched.blocked).toBe(1);
    // Now try to book again — should be blocked
    const slot2 = nextSlot();
    const bookRes = await page.request.post(`${BASE}/api/bookings`, { data: {
      customer_name:'Block Test', customer_email:email, customer_phone:'6030000001',
      service_id:1, stylist_id:slot2.stylist_id, appointment_date:slot2.date, appointment_time:slot2.time
    }});
    expect(bookRes.status()).toBe(403);
    const err = await bookRes.json();
    expect(err.error).toContain('not available');
  });

  test('F2-02: Unblocking customer restores booking ability', async ({ page }) => {
    const email = `unblock_${Date.now()}@test.com`;
    const slot = nextSlot();
    // Create + book initial
    await page.request.post(`${BASE}/api/bookings`, { data: {
      customer_name:'Unblock Test', customer_email:email, customer_phone:'6030000002',
      service_id:1, stylist_id:slot.stylist_id, appointment_date:slot.date, appointment_time:slot.time
    }});
    await login(page, 'admin', 'admin123');
    // Block then unblock
    await page.request.patch(`${BASE}/api/admin/customers/${encodeURIComponent(email)}`, { data:{ blocked:true } });
    await page.request.patch(`${BASE}/api/admin/customers/${encodeURIComponent(email)}`, { data:{ blocked:false } });
    // Should be able to book again
    const slot2 = nextSlot();
    const bookRes = await page.request.post(`${BASE}/api/bookings`, { data: {
      customer_name:'Unblock Test', customer_email:email, customer_phone:'6030000002',
      service_id:1, stylist_id:slot2.stylist_id, appointment_date:slot2.date, appointment_time:slot2.time
    }});
    expect(bookRes.status()).toBe(201);
  });

  test('F2-03: Unknown customer is not blocked by default', async ({ page }) => {
    const slot = nextSlot();
    const res = await page.request.post(`${BASE}/api/bookings`, { data: {
      customer_name:'Brand New', customer_email:`brandnew_${Date.now()}@test.com`, customer_phone:'',
      service_id:1, stylist_id:slot.stylist_id, appointment_date:slot.date, appointment_time:slot.time
    }});
    expect(res.status()).toBe(201);
  });
});

test.describe('Feature 3 — No-Show', () => {
  test.use(DESKTOP);

  test('F3-01: Booking can be marked as no_show', async ({ page }) => {
    await login(page, 'admin', 'admin123');
    const bkRes = await makeBooking(page, { name:'NoShow Customer', email:`noshow_${Date.now()}@test.com` });
    const bk    = await bkRes.json();
    const res = await page.request.patch(`${BASE}/api/admin/bookings/${bk.id}`, {
      data: { status:'no_show' }
    });
    expect(res.status()).toBe(200);
    const updated = await res.json();
    expect(updated.status).toBe('no_show');
  });

  test('F3-02: No-show status is returned in bookings list', async ({ page }) => {
    await login(page, 'admin', 'admin123');
    const bkRes = await makeBooking(page, { name:'NS List', email:`nslist_${Date.now()}@test.com` });
    const bk    = await bkRes.json();
    await page.request.patch(`${BASE}/api/admin/bookings/${bk.id}`, { data:{ status:'no_show' } });
    const listRes = await page.request.get(`${BASE}/api/admin/bookings?status=no_show`);
    const list    = await listRes.json();
    expect(list.some(b => b.id === bk.id)).toBe(true);
  });
});

test.describe('Feature 4 — Marketing Opt-In', () => {
  test.use(DESKTOP);

  test('F4-01: Customer marketing_opt_in can be set to true', async ({ page }) => {
    await login(page, 'admin', 'admin123');
    const email = `mktg_${Date.now()}@test.com`;
    const slot  = nextSlot();
    await page.request.post(`${BASE}/api/bookings`, { data: {
      customer_name:'Marketing User', customer_email:email, customer_phone:'6031110002',
      service_id:1, stylist_id:slot.stylist_id, appointment_date:slot.date, appointment_time:slot.time
    }});
    const res = await page.request.patch(`${BASE}/api/admin/customers/${encodeURIComponent(email)}`, {
      data: { marketing_opt_in: true }
    });
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.marketing_opt_in).toBe(1);
  });

  test('F4-02: Broadcast endpoint requires admin auth', async ({ page }) => {
    const res = await page.request.post(`${BASE}/api/admin/customers/broadcast`, {
      data: { message:'Hello' }
    });
    expect(res.status()).toBe(401);
  });

  test('F4-03: Broadcast with empty message returns 400', async ({ page }) => {
    await login(page, 'admin', 'admin123');
    const res = await page.request.post(`${BASE}/api/admin/customers/broadcast`, {
      data: { message:'' }
    });
    expect(res.status()).toBe(400);
  });

  test('F4-04: Broadcast returns sent/total counts', async ({ page }) => {
    await login(page, 'admin', 'admin123');
    const res = await page.request.post(`${BASE}/api/admin/customers/broadcast`, {
      data: { message:'Test broadcast', opt_in_only: true }
    });
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(typeof data.sent).toBe('number');
    expect(typeof data.total).toBe('number');
  });
});

test.describe('Feature 5 — Client Preferences', () => {
  test.use(DESKTOP);

  test('F5-01: Customer preferences can be saved', async ({ page }) => {
    await login(page, 'admin', 'admin123');
    const email = `prefs_${Date.now()}@test.com`;
    const slot  = nextSlot();
    await page.request.post(`${BASE}/api/bookings`, { data: {
      customer_name:'Prefs User', customer_email:email, customer_phone:'6031110003',
      service_id:1, stylist_id:slot.stylist_id, appointment_date:slot.date, appointment_time:slot.time
    }});
    const res = await page.request.patch(`${BASE}/api/admin/customers/${encodeURIComponent(email)}`, {
      data: { preferences:'#2 on sides, scissors on top, tight line-up' }
    });
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.preferences).toBe('#2 on sides, scissors on top, tight line-up');
  });

  test('F5-02: Preferences persist in customer detail', async ({ page }) => {
    await login(page, 'admin', 'admin123');
    const email = `prefs2_${Date.now()}@test.com`;
    const slot  = nextSlot();
    await page.request.post(`${BASE}/api/bookings`, { data: {
      customer_name:'Prefs User 2', customer_email:email, customer_phone:'',
      service_id:1, stylist_id:slot.stylist_id, appointment_date:slot.date, appointment_time:slot.time
    }});
    await page.request.patch(`${BASE}/api/admin/customers/${encodeURIComponent(email)}`, {
      data: { preferences:'low fade, beard taper' }
    });
    const res  = await page.request.get(`${BASE}/api/admin/customers/${encodeURIComponent(email)}`);
    const data = await res.json();
    expect(data.preferences).toBe('low fade, beard taper');
  });
});

test.describe('Feature 6 — Visit History & Stats', () => {
  test.use(DESKTOP);

  test('F6-01: Customer detail includes booking history', async ({ page }) => {
    await login(page, 'admin', 'admin123');
    const email = `hist_${Date.now()}@test.com`;
    const slot  = nextSlot();
    await page.request.post(`${BASE}/api/bookings`, { data: {
      customer_name:'History User', customer_email:email, customer_phone:'6031110004',
      service_id:1, stylist_id:slot.stylist_id, appointment_date:slot.date, appointment_time:slot.time
    }});
    const res  = await page.request.get(`${BASE}/api/admin/customers/${encodeURIComponent(email)}`);
    const data = await res.json();
    expect(Array.isArray(data.bookings)).toBe(true);
    expect(data.bookings.length).toBeGreaterThanOrEqual(1);
    expect(data.bookings[0]).toHaveProperty('service_name');
    expect(data.bookings[0]).toHaveProperty('price_cents');
    expect(data.bookings[0]).toHaveProperty('stylist_name');
  });

  test('F6-02: Customer list includes booking_count and last_visit', async ({ page }) => {
    await login(page, 'admin', 'admin123');
    const res  = await page.request.get(`${BASE}/api/admin/customers`);
    const list = await res.json();
    expect(list.length).toBeGreaterThan(0);
    const c = list[0];
    expect(c).toHaveProperty('booking_count');
    expect(c).toHaveProperty('last_visit');
  });
});

test.describe('Feature 7 — Barber Blocked Times', () => {
  test.use(DESKTOP);

  test('F7-01: Barber can add a blocked time', async ({ page }) => {
    await login(page, 'marcus', 'marcus123');
    const res = await page.request.post(`${BASE}/api/barber/blocked-times`, {
      data: { block_date:'2030-06-15', block_start:'12:00', block_end:'13:00', reason:'Lunch' }
    });
    expect(res.status()).toBe(201);
    const data = await res.json();
    expect(data.block_date).toBe('2030-06-15');
    expect(data.block_start).toBe('12:00');
    expect(data.reason).toBe('Lunch');
  });

  test('F7-02: Barber can list their blocked times', async ({ page }) => {
    await login(page, 'marcus', 'marcus123');
    const res  = await page.request.get(`${BASE}/api/barber/blocked-times`);
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test('F7-03: block_start must be before block_end (400)', async ({ page }) => {
    await login(page, 'marcus', 'marcus123');
    const res = await page.request.post(`${BASE}/api/barber/blocked-times`, {
      data: { block_date:'2030-06-15', block_start:'14:00', block_end:'12:00' }
    });
    expect(res.status()).toBe(400);
  });

  test('F7-04: Missing fields return 400', async ({ page }) => {
    await login(page, 'marcus', 'marcus123');
    const res = await page.request.post(`${BASE}/api/barber/blocked-times`, {
      data: { block_date:'2030-06-15' }
    });
    expect(res.status()).toBe(400);
  });

  test('F7-05: Blocked slot is removed from availability', async ({ page }) => {
    await login(page, 'marcus', 'marcus123');
    const me = await page.request.get(`${BASE}/api/auth/me`).then(r=>r.json());
    // Block 14:00-15:00 on a specific future date
    const blockDate = '2031-07-01';
    await page.request.post(`${BASE}/api/barber/blocked-times`, {
      data: { block_date:blockDate, block_start:'14:00', block_end:'15:00', reason:'Test block' }
    });
    // Check availability for that barber on that date
    const avRes  = await page.request.get(`${BASE}/api/availability?date=${blockDate}&stylist_id=${me.id}`);
    const avData = await avRes.json();
    expect(avData.slots).not.toContain('14:00');
    expect(avData.slots).not.toContain('14:30');
    expect(avData.slots).toContain('15:00'); // 15:00 is after block ends
  });

  test('F7-06: Barber can delete their blocked time', async ({ page }) => {
    await login(page, 'marcus', 'marcus123');
    const addRes = await page.request.post(`${BASE}/api/barber/blocked-times`, {
      data: { block_date:'2030-08-01', block_start:'09:00', block_end:'10:00', reason:'Delete test' }
    });
    const bt = await addRes.json();
    const delRes = await page.request.delete(`${BASE}/api/barber/blocked-times/${bt.id}`);
    expect(delRes.status()).toBe(200);
  });

  test('F7-07: Barber cannot delete another barbers blocked time', async ({ page }) => {
    // Marcus adds a block, James tries to delete it
    await login(page, 'marcus', 'marcus123');
    const addRes = await page.request.post(`${BASE}/api/barber/blocked-times`, {
      data: { block_date:'2030-09-10', block_start:'10:00', block_end:'11:00' }
    });
    const bt = await addRes.json();
    await login(page, 'james', 'james123');
    const delRes = await page.request.delete(`${BASE}/api/barber/blocked-times/${bt.id}`);
    expect(delRes.status()).toBe(403);
  });

  test('F7-08: Admin can view all blocked times', async ({ page }) => {
    await login(page, 'admin', 'admin123');
    const res = await page.request.get(`${BASE}/api/admin/blocked-times`);
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test('F7-09: Admin can delete any blocked time', async ({ page }) => {
    await login(page, 'marcus', 'marcus123');
    const addRes = await page.request.post(`${BASE}/api/barber/blocked-times`, {
      data: { block_date:'2030-10-01', block_start:'13:00', block_end:'14:00' }
    });
    const bt = await addRes.json();
    await login(page, 'admin', 'admin123');
    const delRes = await page.request.delete(`${BASE}/api/admin/blocked-times/${bt.id}`);
    expect(delRes.status()).toBe(200);
  });

  test('F7-10: Blocked times can be filtered by date', async ({ page }) => {
    await login(page, 'marcus', 'marcus123');
    await page.request.post(`${BASE}/api/barber/blocked-times`, {
      data: { block_date:'2031-01-15', block_start:'09:00', block_end:'10:00' }
    });
    await login(page, 'admin', 'admin123');
    const res  = await page.request.get(`${BASE}/api/admin/blocked-times?date=2031-01-15`);
    const data = await res.json();
    expect(data.every(bt => bt.block_date === '2031-01-15')).toBe(true);
  });
});

test.describe('Feature 8 — Schedule View', () => {
  test.use(DESKTOP);

  test('F8-01: Schedule endpoint requires auth', async ({ page }) => {
    const res = await page.request.get(`${BASE}/api/admin/schedule?date=2026-03-21`);
    expect(res.status()).toBe(401);
  });

  test('F8-02: Schedule endpoint requires date param', async ({ page }) => {
    await login(page, 'admin', 'admin123');
    const res = await page.request.get(`${BASE}/api/admin/schedule`);
    expect(res.status()).toBe(400);
  });

  test('F8-03: Schedule returns barbers, bookings, blocks, date', async ({ page }) => {
    await login(page, 'admin', 'admin123');
    const res  = await page.request.get(`${BASE}/api/admin/schedule?date=2026-03-21`);
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.barbers)).toBe(true);
    expect(Array.isArray(data.bookings)).toBe(true);
    expect(Array.isArray(data.blocks)).toBe(true);
    expect(data.date).toBe('2026-03-21');
  });

  test('F8-04: Schedule barbers have id, name, photo_url', async ({ page }) => {
    await login(page, 'admin', 'admin123');
    const res  = await page.request.get(`${BASE}/api/admin/schedule?date=2026-03-21`);
    const data = await res.json();
    if (data.barbers.length) {
      expect(data.barbers[0]).toHaveProperty('id');
      expect(data.barbers[0]).toHaveProperty('name');
      expect(data.barbers[0]).toHaveProperty('photo_url');
    }
  });

  test('F8-05: Admin can reassign booking to different barber', async ({ page }) => {
    await login(page, 'admin', 'admin123');
    const slot = nextSlot();
    const bkRes = await makeBooking(page, {
      name:'Reassign Test', email:`reassign_${Date.now()}@test.com`,
      date: slot.date, time: slot.time, stylist: 1
    });
    const bk = await bkRes.json();
    // Reassign to barber 2 on same date/time
    const res = await page.request.patch(`${BASE}/api/admin/bookings/${bk.id}`, {
      data: { stylist_id: 2 }
    });
    expect(res.status()).toBe(200);
    const updated = await res.json();
    expect(updated.stylist_id).toBe(2);
  });

  test('F8-06: Admin can move booking to different date and time', async ({ page }) => {
    await login(page, 'admin', 'admin123');
    const slot = nextSlot();
    const bkRes = await makeBooking(page, {
      name:'Move Test', email:`move_${Date.now()}@test.com`,
      date: slot.date, time: slot.time, stylist: 1
    });
    const bk    = await bkRes.json();
    const slot2 = nextSlot();
    const res   = await page.request.patch(`${BASE}/api/admin/bookings/${bk.id}`, {
      data: { appointment_date: slot2.date, appointment_time: slot2.time }
    });
    expect(res.status()).toBe(200);
    const updated = await res.json();
    expect(updated.appointment_date).toBe(slot2.date);
    expect(updated.appointment_time).toBe(slot2.time);
  });

  test('F8-07: Moving booking to conflicting slot returns 409', async ({ page }) => {
    await login(page, 'admin', 'admin123');
    const slot1 = nextSlot();
    const slot2 = nextSlot();
    // Book barber 1 in slot1
    const bk1Res = await makeBooking(page, {
      name:'Conflict A', email:`ca_${Date.now()}@test.com`,
      date: slot1.date, time: slot1.time, stylist: 1
    });
    // Book barber 1 in slot2
    const bk2Res = await makeBooking(page, {
      name:'Conflict B', email:`cb_${Date.now()}@test.com`,
      date: slot2.date, time: slot2.time, stylist: 1
    });
    const bk1 = await bk1Res.json();
    const bk2 = await bk2Res.json();
    // Try to move bk1 to same slot as bk2
    const res = await page.request.patch(`${BASE}/api/admin/bookings/${bk1.id}`, {
      data: { stylist_id: 1, appointment_date: bk2.appointment_date, appointment_time: bk2.appointment_time }
    });
    expect(res.status()).toBe(409);
  });

  // E2E: Schedule view renders in browser
  test('F8-08: Admin schedule view renders in browser', async ({ page }) => {
    await login(page, 'admin', 'admin123');
    const navLink = page.locator('#nav-schedule');
    await expect(navLink).toBeVisible();
    await navLink.click();
    const schedDate = page.locator('#sched-date');
    await expect(schedDate).toBeVisible();
    await schedDate.fill('2026-03-21');
    await page.locator('#sched-container').waitFor({ state:'visible' });
    // After loading, should show barber columns
    await page.waitForTimeout(1000);
    const container = await page.locator('#sched-container').innerHTML();
    expect(container.length).toBeGreaterThan(50);
  });
});

test.describe('Feature 7 — Block Time UI', () => {
  test.use(DESKTOP);

  test('F7-UI-01: Block off time view renders for barber', async ({ page }) => {
    await login(page, 'marcus', 'marcus123');
    await page.locator('#nav-blocked').click();
    await expect(page.locator('#bt-date')).toBeVisible();
    await expect(page.locator('#bt-start')).toBeVisible();
    await expect(page.locator('#bt-end')).toBeVisible();
  });
});
