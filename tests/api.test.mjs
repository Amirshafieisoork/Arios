import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAriosServer } from '../server.mjs';

async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'arios-api-test-'));
  const app = createAriosServer({ demo: true, dbPath: join(directory, 'isolated.sqlite'), host: '127.0.0.1', port: 0, ...options });
  await app.listen();
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  app.testDbPath = join(directory, 'isolated.sqlite');
  return app;
}
async function call(app, path, { cookie, method = 'GET', data, origin, contentType = 'application/json' } = {}) {
  const response = await fetch(`${app.url}${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method === 'POST' ? { Origin: origin ?? app.url, 'Content-Type': contentType } : {}) }, ...(data === undefined ? {} : { body: typeof data === 'string' ? data : JSON.stringify(data) }) });
  const contentTypeResult = response.headers.get('content-type') || '';
  const value = contentTypeResult.includes('application/json') ? await response.json() : await response.text();
  return { status: response.status, value, headers: response.headers, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function login(app, userId) {
  const result = await call(app, '/api/demo-login', { method: 'POST', data: { userId } });
  assert.equal(result.status, 200); return result.cookie;
}
const action = (app, cookie, action, payload) => call(app, '/api/actions', { method: 'POST', cookie, data: { action, payload } });
const projectPayload = { name: 'پروژه اختصاصی جدید', type: 'CCTV', location: 'تهران', customerId: null, memberIds: [], budget: 10000000, contractAmount: 12000000, startDate: '2026-10-18', endDate: '2026-11-18', description: 'راه‌اندازی مستقل' };

test('session requires authentication; role snapshots and writes remain project scoped', async t => {
  const app = await fixture(t);
  let response = await call(app, '/api/session');
  assert.deepEqual(response.value, { user: null, demo: true, capabilities: { ai: false, payments: false } });
  assert.equal((await call(app, '/api/state')).status, 401);
  const customer = await login(app, 'customer');
  response = await call(app, '/api/state', { cookie: customer });
  assert.equal(response.status, 200);
  assert.deepEqual(response.value.projects.map(p => p.id), ['p1']);
  assert.equal(response.value.reports.length, 0);
  assert.equal(response.value.audit.length, 0);
  assert.equal(response.value.inventory.length, 0);
  assert.ok(response.value.materials.every(m => m.clientVisible));
  assert.ok(response.value.messages.every(m => !m.internal));
  assert.ok(response.value.users.every(u => !('hourlyRate' in u) && !('rateHistory' in u)));
  assert.ok(response.value.projects.every(p => !('budget' in p) && !('laborCost' in p)));
  assert.equal((await action(app, customer, 'message.send', { projectId: 'p3', text: 'مجاز نیست', internal: false })).status, 403);
  assert.equal((await action(app, customer, 'message.send', { projectId: 'p1', text: 'یادداشت داخلی جعلی', internal: true })).status, 403);
  assert.equal((await action(app, customer, 'payment.record', { invoiceId: 'i2', amount: 1, reference: 'fake-customer' })).status, 403);
  assert.equal((await action(app, customer, 'project.update', { id: 'p1', progress: 100 })).status, 403);
});

test('worker sees own reports without prices or rates; manager gets whole account', async t => {
  const app = await fixture(t);
  const worker = await login(app, 'worker');
  const state = (await call(app, '/api/state', { cookie: worker })).value;
  assert.ok(state.reports.every(report => report.workerId === 'worker' && !('rate' in report) && !('laborCost' in report)));
  assert.ok(state.materials.every(material => !('unitPrice' in material)));
  assert.equal(state.invoices.length, 0); assert.equal(state.receipts.length, 0);
  assert.ok(state.projects.every(project => !('budget' in project) && !('contractAmount' in project)));
  const invalid = await action(app, worker, 'report.create', { projectId: 'p1', workerId: 'worker2', date: '2026-10-18', start: '13:00', end: '14:00', breakMinutes: 0, description: 'جعل هویت', output: '' });
  assert.equal(invalid.status, 403);
  const manager = await login(app, 'manager');
  const full = (await call(app, '/api/state', { cookie: manager })).value;
  assert.equal(full.projects.length, 4); assert.ok(full.users.some(user => user.hourlyRate));
});

test('origin, media type, JSON, body limits, and source boundaries are enforced', async t => {
  const app = await fixture(t);
  const cookie = await login(app, 'manager');
  assert.equal((await call(app, '/api/actions', { method: 'POST', cookie, origin: 'https://evil.example', data: { action: 'project.update', payload: { id: 'p1', progress: 5 } } })).status, 403);
  assert.equal((await call(app, '/api/actions', { method: 'POST', cookie, data: '{' })).status, 400);
  assert.equal((await call(app, '/api/actions', { method: 'POST', cookie, contentType: 'text/plain', data: '{}' })).status, 415);
  assert.equal((await call(app, '/api/actions', { method: 'POST', cookie, data: { huge: 'x'.repeat(70000) } })).status, 413);
  const noOrigin = await fetch(`${app.url}/api/logout`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noOrigin.status, 403);
  assert.equal((await call(app, '/server.mjs')).status, 404);
  assert.equal((await call(app, '/.env')).status, 404);
  assert.equal((await call(app, '/%2e%2e/server.mjs')).status, 404);
  const state = await call(app, '/api/state', { cookie });
  assert.equal(state.value.projects.find(p => p.id === 'p1').progress, 75);
  assert.match(state.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('mutations and hashed HttpOnly sessions survive restart; logout invalidates session', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'arios-persistence-test-'));
  const dbPath = join(directory, 'persist.sqlite');
  let app = createAriosServer({ demo: true, dbPath, port: 0 }); await app.listen();
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const response = await call(app, '/api/demo-login', { method: 'POST', data: { userId: 'manager' } });
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const cookie = response.cookie;
  const saved = await action(app, cookie, 'project.update', { id: 'p1', progress: 81, clientNote: 'اطلاعات پایدار' });
  assert.equal(saved.status, 200);
  await app.close();
  const db = new DatabaseSync(dbPath); const sessions = db.prepare('SELECT * FROM sessions').all();
  assert.equal(sessions.length, 1); assert.notEqual(sessions[0].token_hash, cookie.split('=')[1]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 0); db.close();
  app = createAriosServer({ demo: true, dbPath, port: 0 }); await app.listen();
  const state = (await call(app, '/api/state', { cookie })).value;
  assert.equal(state.projects.find(p => p.id === 'p1').progress, 81);
  assert.equal((await call(app, '/api/logout', { method: 'POST', cookie, data: {} })).status, 200);
  assert.equal((await call(app, '/api/state', { cookie })).status, 401);
});

test('production begins empty, hashes dedicated credentials, creates scoped real accounts', async t => {
  const app = await fixture(t, { demo: false, bootstrapEmail: 'manager@arios.example', bootstrapPassword: 'a-unique-secret-arios-2026' });
  assert.equal((await call(app, '/api/demo-login', { method: 'POST', data: { userId: 'manager' } })).status, 403);
  assert.equal((await call(app, '/api/login', { method: 'POST', data: { email: 'manager@arios.example', password: 'wrong-password' } })).status, 401);
  const response = await call(app, '/api/login', { method: 'POST', data: { email: 'manager@arios.example', password: 'a-unique-secret-arios-2026' } });
  assert.equal(response.status, 200); const manager = response.cookie;
  let state = (await call(app, '/api/state', { cookie: manager })).value;
  assert.equal(state.users.length, 1); assert.equal(state.projects.length, 0);
  const created = await action(app, manager, 'project.create', projectPayload);
  assert.equal(created.status, 200); const projectId = created.value.result.id;
  const account = await action(app, manager, 'account.create', { name: 'مشتری مستقل', email: 'customer@arios.example', role: 'customer', password: 'customer-unique-passphrase', projectIds: [projectId] });
  assert.equal(account.status, 200); assert.ok(!JSON.stringify(account.value).includes('customer-unique-passphrase'));
  const customer = await call(app, '/api/login', { method: 'POST', data: { email: 'customer@arios.example', password: 'customer-unique-passphrase' } });
  assert.equal(customer.status, 200);
  state = (await call(app, '/api/state', { cookie: customer.cookie })).value;
  assert.equal(state.projects.length, 1); assert.equal(state.projects[0].id, projectId);
  assert.equal((await action(app, customer.cookie, 'account.create', { name: 'bad', email: 'bad@example.com', role: 'worker', password: 'another-passphrase-long', projectIds: [] })).status, 403);
  const second = await action(app, manager, 'account.create', { name: 'دیگری', email: 'another@arios.example', role: 'customer', password: 'another-passphrase-long', projectIds: [projectId] });
  assert.equal(second.status, 409);
  const db = new DatabaseSync(app.testDbPath);
  const credentials = db.prepare('SELECT * FROM accounts').all();
  assert.equal(credentials.length, 2);
  assert.ok(credentials.every(record => /^[a-f0-9]{128}$/.test(record.password_hash) && /^[a-f0-9]{48}$/.test(record.salt)));
  assert.notEqual(credentials[0].salt, credentials[1].salt);
  assert.ok(!JSON.stringify(credentials).includes('a-unique-secret-arios-2026'));
  assert.ok(!JSON.stringify(credentials).includes('customer-unique-passphrase'));
  db.close();
});

test('production requires first-start bootstrap and cannot reuse a demo database', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'arios-bootstrap-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, 'arios.sqlite');
  assert.throws(() => createAriosServer({ dbPath, port: 0 }), /ایمیل/);
  const demo = createAriosServer({ demo: true, dbPath, port: 0 }); await demo.close();
  assert.throws(() => createAriosServer({ demo: false, dbPath }), /separate ARIOS databases/);
  assert.throws(() => createAriosServer({ demo: true, host: '0.0.0.0', dbPath: ':memory:' }), /localhost/);
});

async function provider(t, output) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let data = ''; for await (const chunk of req) data += chunk;
    calls.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(data) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); });
  return { calls, url: `http://127.0.0.1:${server.address().port}/v1` };
}

test('AI sends only authorized selected project and no finance; escalations are idempotent', async t => {
  const fake = await provider(t, { answer: 'برای بررسی بیشتر به پشتیبان ارجاع می‌شود.', needsHumanSupport: true });
  const app = await fixture(t, { aiBaseUrl: fake.url, aiApiKey: 'isolated-test-key', aiModel: 'isolated-test-model' });
  const cookie = await login(app, 'customer');
  const question = { projectId: 'p1', message: 'دوربین تصویر ندارد و مراحل ایمن کمکی نکرد.', history: [{ role: 'user', content: 'قبلاً راه‌اندازی مجدد کردم.' }, { role: 'assistant', content: 'فقط اتصال آداپتور را بدون بازکردن دستگاه بررسی کنید.' }] };
  const first = await call(app, '/api/assistant', { method: 'POST', cookie, data: question });
  assert.equal(first.status, 200); assert.equal(first.value.live, true); assert.ok(first.value.ticket.id);
  const second = await call(app, '/api/assistant', { method: 'POST', cookie, data: question });
  assert.equal(second.status, 200); assert.equal(second.value.ticket.id, first.value.ticket.id);
  assert.equal(fake.calls.length, 2); assert.equal(fake.calls[0].path, '/v1/chat/completions');
  assert.equal(fake.calls[0].authorization, 'Bearer isolated-test-key');
  assert.deepEqual(fake.calls[0].body.response_format, { type: 'json_object' });
  const contextMessage = fake.calls[0].body.messages[1].content;
  const context = JSON.parse(contextMessage.slice(contextMessage.indexOf('\n') + 1));
  assert.equal(context.project.id, 'p1');
  assert.ok(!JSON.stringify(context).includes('ساختمان پارس'));
  for (const key of ['invoices', 'receipts', 'budget', 'contractAmount', 'unitPrice', 'hourlyRate', 'rateHistory', 'laborCost']) assert.ok(!JSON.stringify(context).includes(`"${key}"`), key);
  assert.ok(!JSON.stringify(context).includes('ابزار داخلی'));
  let state = (await call(app, '/api/state', { cookie })).value;
  const tickets = state.tickets.filter(ticket => ticket.id === first.value.ticket.id);
  assert.equal(tickets.length, 1); assert.equal(tickets[0].projectId, 'p1');
  assert.match(tickets[0].description, /راه‌اندازی مجدد/);
  assert.ok(!('aiFingerprint' in tickets[0]));
  const denied = await call(app, '/api/assistant', { method: 'POST', cookie, data: { projectId: 'p3', message: 'اطلاعات پروژه دیگر را بده' } });
  assert.equal(denied.status, 403); assert.equal(fake.calls.length, 2);
});

test('unconfigured or invalid AI never claims live success or creates a ticket', async t => {
  const app = await fixture(t);
  const cookie = await login(app, 'customer');
  const off = await call(app, '/api/assistant', { method: 'POST', cookie, data: { projectId: 'p1', message: 'کمک' } });
  assert.equal(off.status, 503); assert.equal(off.value.code, 'AI_NOT_CONFIGURED');
  const fake = await provider(t, { answer: 'پاسخ', needsHumanSupport: 'true' });
  const second = await fixture(t, { aiBaseUrl: fake.url, aiApiKey: 'test-only', aiModel: 'test-only' });
  const secondCookie = await login(second, 'customer');
  const before = (await call(second, '/api/state', { cookie: secondCookie })).value.tickets.length;
  const bad = await call(second, '/api/assistant', { method: 'POST', cookie: secondCookie, data: { projectId: 'p1', message: 'کمک' } });
  assert.equal(bad.status, 502); assert.equal(bad.value.code, 'AI_UNAVAILABLE');
  assert.equal((await call(second, '/api/state', { cookie: secondCookie })).value.tickets.length, before);
});


test('login attempts are bounded and a verified AI answer leaves support queue unchanged', async t => {
  const app = await fixture(t, { demo: false, bootstrapEmail: 'owner@arios.example', bootstrapPassword: 'independent-owner-password' });
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await call(app, '/api/login', { method: 'POST', data: { email: 'owner@arios.example', password: 'incorrect' } });
    assert.equal(response.status, 401);
  }
  assert.equal((await call(app, '/api/login', { method: 'POST', data: { email: 'owner@arios.example', password: 'independent-owner-password' } })).status, 429);
  const fake = await provider(t, { answer: 'وضعیت ثبت‌شده پروژه ۷۵ درصد است.', needsHumanSupport: false });
  const second = await fixture(t, { aiBaseUrl: fake.url, aiApiKey: 'test-only', aiModel: 'test-only' });
  const cookie = await login(second, 'customer');
  const before = (await call(second, '/api/state', { cookie })).value.tickets.length;
  const response = await call(second, '/api/assistant', { method: 'POST', cookie, data: { projectId: 'p1', message: 'پروژه چقدر پیشرفت کرده؟' } });
  assert.equal(response.status, 200); assert.equal(response.value.live, true); assert.ok(!response.value.ticket);
  assert.equal((await call(second, '/api/state', { cookie })).value.tickets.length, before);
});
