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
