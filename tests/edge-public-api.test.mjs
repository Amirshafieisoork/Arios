import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';

// Bundle the actual Edge entrypoint while replacing only the external SDK constructor.
// All route/auth/assistant/domain code remains the production implementation.
const built = await build({
  entryPoints: [resolve('supabase/functions/arios-api/index.ts')], bundle: true, write: false,
  format: 'esm', platform: 'node', target: 'node24',
  plugins: [{ name: 'supabase-test-client', setup(builder) {
    builder.onResolve({ filter: /^npm:@supabase\/supabase-js@/ }, () => ({ path: 'test-client', namespace: 'supabase-test-client' }));
    builder.onLoad({ filter: /.*/, namespace: 'supabase-test-client' }, () => ({ contents: 'export function createClient(){throw new Error("A test must inject its SDK client");}', loader: 'js' }));
  } }],
});
const { createHandler } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));

function fixture() {
  const calls = { auth: 0, state: 0, provider: 0, setting: 0 },
    state = { projects: [{ id: 'published', publicVisible: true, publicTitle: 'پروژه عمومی', publicSummary: 'شرح عمومی', name: 'private-client-name', location: 'private-location', type: 'CCTV', customerId: 'private-customer', budget: 50000 }] };
  const repo = {
    loadState: async () => { calls.state++; return { state, revision: 1 }; },
    getSetting: async () => { calls.setting++; return {}; },
    rateLimit: async () => ({ allowed: true }),
  };
  const client = { auth: { getUser: async () => { calls.auth++; return { data: { user: null }, error: { status: 401 } }; } } };
  const handle = createHandler({ repo, client, fetcher: () => { calls.provider++; assert.fail('An unconfigured or unauthorized request cannot call a provider'); } });
  const request = (path, payload) => new Request('https://edge.example/functions/v1/arios-api' + path, payload === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return { handle, request, calls };
}

test('Edge public projects route is anonymous but exposes only the explicit publication view', async () => {
  const f = fixture(), response = await f.handle(f.request('/public-projects'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.projects[0].title, 'پروژه عمومی');
  assert.equal(body.projects[0].cover, '/assets/photos/arios-network.webp');
  const text = JSON.stringify(body);
  for (const value of ['private-client-name', 'private-location', 'private-customer', 'budget']) assert(!text.includes(value));
  assert.equal(f.calls.auth, 0); assert.equal(f.calls.state, 1); assert.equal(f.calls.provider, 0);
});

test('Edge public chat works as an honest guide without reading operational state or authenticating a visitor', async () => {
  const f = fixture(), response = await f.handle(f.request('/public-assistant', { message: 'سلام، خدمات شبکه می‌خواهم' }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.live, false); assert.equal(body.mode, 'guide'); assert.match(body.answer, /شبکه/);
  assert.equal(f.calls.auth, 0); assert.equal(f.calls.state, 0); assert.equal(f.calls.provider, 0);
});

test('Edge private state and integration diagnostics still require an authenticated workspace member', async () => {
  for (const [path, payload] of [['/state', undefined], ['/integrations/test', {}]]) {
    const f = fixture(), response = await f.handle(f.request(path, payload));
    assert.equal(response.status, 401, path);
    assert.equal((await response.json()).code, 'UNAUTHORIZED');
    assert.equal(f.calls.state, 0); assert.equal(f.calls.setting, 0); assert.equal(f.calls.provider, 0);
  }
});

test('Edge health reports the released backend version without exposing integrations', async () => {
  const f = fixture(), response = await f.handle(f.request('/health'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, version: '0.4.0', mode: 'supabase', initialized: true });
  assert.equal(f.calls.setting, 0); assert.equal(f.calls.provider, 0);
});

function accountFixture(role = 'manager') {
  const users = [
    { id: 'manager', role: 'manager', name: 'مدیر' },
    { id: 'worker', role: 'worker', name: 'همکار' },
    { id: 'target', role: 'customer', name: 'مشتری', phone: '+989123456789' },
  ];
  const state = Object.fromEntries(['projects', 'reports', 'materials', 'invoices', 'messages', 'tickets', 'inventory', 'receipts', 'audit'].map(name => [name, []]));
  state.users = users;
  const settings = new Map(), calls = { auth: 0, reset: 0, provider: 0 };
  const repo = {
    loadState: async () => ({ state, revision: 1 }),
    rateLimit: async () => ({ allowed: true }),
    getProfile: async () => ({ auth_user_id: 'auth-' + role, domain_user_id: role, role }),
    getProfileByDomainId: async id => ({ auth_user_id: 'auth-' + id, domain_user_id: id, role: users.find(user => user.id === id)?.role }),
    getSetting: async key => settings.get(key),
    setSetting: async (key, value) => settings.set(key, value),
    acquireLock: async () => true,
    releaseLock: async () => {},
  };
  const client = { auth: {
    getUser: async () => { calls.auth++; return { data: { user: { id: 'auth-' + role } } }; },
    admin: { updateUserById: async (id, values) => { calls.reset++; assert.deepEqual(values, { password: 'simple6' }); return { data: { user: { id } } }; } },
  } };
  const handle = createHandler({ repo, client, fetcher: () => { calls.provider++; assert.fail('Account routes cannot call an AI provider'); } });
  const request = (path, payload, authenticated = true) => new Request('https://edge.example/functions/v1/arios-api' + path, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { ...(authenticated ? { Authorization: 'Bearer verified-test-session' } : {}), ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  return { handle, request, calls, settings, state };
}

test('Edge recovery requests are anonymous and return the same acknowledgement for known and unknown phones', async () => {
  const f = accountFixture(), replies = [];
  for (const phone of ['09123456789', '09999999999']) {
    const response = await f.handle(f.request('/password-reset/request', { phone }, false));
    assert.equal(response.status, 200);
    replies.push(await response.json());
  }
  assert.deepEqual(replies[0], replies[1]);
  assert.equal(replies[0].ok, true);
  assert.equal(f.calls.auth, 0); assert.equal(f.calls.reset, 0); assert.equal(f.calls.provider, 0);
  assert.equal(f.settings.get('password-reset-requests').length, 1, 'Unknown callers cannot evict real recovery requests');
  for (const reply of replies) assert(!JSON.stringify(reply).includes('target'));
});

test('Edge recovery requests list remains restricted to a manager', async () => {
  const manager = accountFixture();
  manager.settings.set('password-reset-requests', [{ id: 'reset-1', status: 'pending', identifier: '+989123456789', userId: 'target' }]);
  const allowed = await manager.handle(manager.request('/password-reset/requests'));
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).requests[0].id, 'reset-1');
  const employee = accountFixture('worker'), denied = await employee.handle(employee.request('/password-reset/requests'));
  assert.equal(denied.status, 403); assert.equal((await denied.json()).code, 'FORBIDDEN');
  const anonymous = await manager.handle(manager.request('/password-reset/requests', undefined, false));
  assert.equal(anonymous.status, 401); assert.equal((await anonymous.json()).code, 'UNAUTHORIZED');
});

test('Edge manager password reset invokes the protected Auth helper and returns no password', async () => {
  const f = accountFixture();
  const response = await f.handle(f.request('/actions', { action: 'account.password.reset', payload: { id: 'target', password: 'simple6' } }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.result, { id: 'target', ok: true, sessionsRevoked: true });
  assert.equal(f.calls.reset, 1); assert.equal(f.calls.provider, 0);
  assert.equal(f.settings.get('auth-security:target').blocked, false);
  assert(!JSON.stringify(body).includes('simple6'));
});

test('Edge account security actions reject team members before invoking Auth mutations', async () => {
  for (const action of ['account.archive', 'account.restore', 'account.password.reset']) {
    const f = accountFixture('worker');
    const response = await f.handle(f.request('/actions', { action, payload: { id: 'target', password: 'simple6' } }));
    assert.equal(response.status, 403, action);
    assert.equal((await response.json()).code, 'FORBIDDEN');
    assert.equal(f.calls.reset, 0); assert.equal(f.settings.size, 0);
  }
});
