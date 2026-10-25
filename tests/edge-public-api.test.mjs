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
  return { handle, request, calls, repo };
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

test('scheduled Telegram dispatch requires its private credential before any user or delivery work', async () => {
  for (const token of [undefined, 'a'.repeat(64)]) {
    const f = fixture();
    const headers = {'Content-Type': 'application/json'};
    if (token) headers['x-arios-scheduler-token'] = token;
    const response = await f.handle(new Request('https://edge.example/functions/v1/arios-api/internal/telegram-tick', {method: 'POST', headers, body: '{}'}));
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.code, 'SCHEDULER_UNAUTHORIZED');
    assert(!JSON.stringify(body).includes('a'.repeat(64)));
    assert.equal(f.calls.auth, 0);
    assert.equal(f.calls.state, 0);
    assert.equal(f.calls.provider, 0);
  }
  const f = fixture();
  const response = await f.handle(f.request('/internal/telegram-tick'));
  assert.equal(response.status, 405);
  assert.equal(f.calls.auth, 0);
  assert.equal(f.calls.provider, 0);
});

test('Telegram reminder configuration and delivery status require a workspace session', async () => {
  for (const [path, payload] of [['/reminders', undefined], ['/reminders/settings', {enabled: true}]]) {
    const f = fixture(), response = await f.handle(f.request(path, payload));
    assert.equal(response.status, 401, path);
    assert.equal((await response.json()).code, 'UNAUTHORIZED');
    assert.equal(f.calls.provider, 0);
  }
});

test('a signed scheduler tick bypasses user login only once and exposes no signing credential', async () => {
  const f = fixture(), key = 'b'.repeat(64), nonce = 'c'.repeat(32), timestamp = String(Math.floor(Date.now() / 1000));
  const canonical = `POST\n/api/internal/telegram-tick\n${timestamp}\n${nonce}`;
  const signingKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const signature = Buffer.from(await crypto.subtle.sign('HMAC', signingKey, new TextEncoder().encode(canonical))).toString('hex');
  const markers = new Set(); let ticks = 0;
  f.repo.getSetting = async name => name === 'telegram_scheduler_signing_key' ? key : {};
  f.repo.setSetting = async name => { assert.equal(name, 'telegram_reminder_last_tick'); ticks++; };
  f.repo.acquireLock = async name => { if (markers.has(name)) return false; markers.add(name); return true; };
  const request = () => new Request('https://edge.example/functions/v1/arios-api/internal/telegram-tick', {method: 'POST', headers: {
    'Content-Type': 'application/json', 'x-arios-scheduler-timestamp': timestamp,
    'x-arios-scheduler-nonce': nonce, 'x-arios-scheduler-signature': signature,
  }, body: '{}'});
  const response = await f.handle(request());
  assert.equal(response.status, 200);
  const text = await response.text(); assert(!text.includes(key)); assert(!text.includes(signature));
  assert.equal(ticks, 1); assert.equal(f.calls.auth, 0); assert.equal(f.calls.state, 0); assert.equal(f.calls.provider, 0);
  const replay = await f.handle(request()); assert.equal(replay.status, 401); assert.equal(ticks, 1);
});

test('Edge health reports the released backend version without exposing integrations', async () => {
  const f = fixture(), response = await f.handle(f.request('/health'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, version: '0.4.0', mode: 'supabase', initialized: true });
  assert.equal(f.calls.setting, 0); assert.equal(f.calls.provider, 0);
});

function accountFixture(role = 'manager', { legacy = false } = {}) {
  const users = [
    { id: 'manager', role: 'manager', name: 'مدیر' },
    { id: 'worker', role: 'worker', name: 'همکار' },
    { id: 'target', role: 'customer', name: 'مشتری', phone: '+989123456789' },
  ];
  const state = Object.fromEntries(['projects', 'reports', 'materials', 'invoices', 'messages', 'tickets', 'inventory', 'receipts', 'audit'].map(name => [name, []]));
  state.users = users;
  const profiles = new Map(users.filter(user => !legacy || user.id !== 'target').map(user => [user.id, { auth_user_id: 'auth-' + user.id, domain_user_id: user.id, role: user.role }]));
  const settings = new Map(), calls = { auth: 0, reset: 0, provider: 0 };
  const repo = {
    loadState: async () => ({ state, revision: 1 }),
    rateLimit: async () => ({ allowed: true }),
    getProfile: async authId => [...profiles.values()].find(profile => profile.auth_user_id === authId),
    getProfileByDomainId: async id => profiles.get(id),
    listProfileLinks: async () => [...profiles.values()].map(({ domain_user_id, role }) => ({ domain_user_id, role })),
    updateAccount: async input => { assert.equal(input.authUserId, profiles.get(input.domainUserId)?.auth_user_id || null); Object.assign(state, input.state); if(profiles.has(input.domainUserId))profiles.get(input.domainUserId).role=input.role; return true; },
    commitAccount: async input => { assert(!profiles.has(input.domainUserId)); Object.assign(state,input.state); profiles.set(input.domainUserId,{auth_user_id:input.authUserId,domain_user_id:input.domainUserId,role:input.role}); return true; },
    getSetting: async key => settings.get(key),
    setSetting: async (key, value) => settings.set(key, value),
    acquireLock: async () => true,
    releaseLock: async () => {},
  };
  const client = { auth: {
    getUser: async () => { calls.auth++; return { data: { user: { id: 'auth-' + role } } }; },
    admin: { createUser: async () => ({data:{user:{id:'new-activated-auth'}}}), updateUserById: async (id, values) => { calls.reset++; assert.deepEqual(values, { password: 'simple6' }); return { data: { user: { id } } }; } },
  } };
  const handle = createHandler({ repo, client, fetcher: () => { calls.provider++; assert.fail('Account routes cannot call an AI provider'); } });
  const request = (path, payload, authenticated = true) => new Request('https://edge.example/functions/v1/arios-api' + path, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { ...(authenticated ? { Authorization: 'Bearer verified-test-session' } : {}), ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  return { handle, request, calls, settings, state, repo };
}

test('Edge callback receipt requires explicit consent and a successful private write without authentication or AI', async () => {
  const f = fixture(), row = { id: '11111111-2222-4333-8444-555555555555', status: 'new', created_at: '2026-10-24T12:00:00Z' };
  f.repo.findLeadRequest = async () => null;
  f.repo.createLead = async input => ({ created: true, lead: { ...row, request_hash: input.requestHash } });
  const payload = { phone: '09123456789', requestId: '01234567-89ab-4cde-8f01-234567890abc', consent: true };
  const saved = await f.handle(f.request('/public-leads', payload));
  assert.equal(saved.status, 201); assert.equal((await saved.json()).accepted, true);
  assert.equal(f.calls.auth, 0); assert.equal(f.calls.provider, 0); assert.equal(f.calls.state, 0);
  const noConsent = await f.handle(f.request('/public-leads', { ...payload, consent: false }));
  assert.equal(noConsent.status, 400); assert.equal((await noConsent.json()).code, 'CONSENT_REQUIRED');
  f.repo.createLead = async () => { throw Error('write failed'); };
  const failed = await f.handle(f.request('/public-leads', payload));
  assert.equal(failed.status, 500); const body = await failed.json(); assert.equal(body.accepted, undefined); assert(!JSON.stringify(body).includes('write failed'));
});

test('Edge callback inbox and status update routes enforce manager access before repository calls', async () => {
  const f = accountFixture();
  const lead = { id: '11111111-2222-4333-8444-555555555555', name: '', phone: '+989123456789', message: '', status: 'new', created_at: '2026-10-24T12:00:00Z', updated_at: '2026-10-24T12:00:00Z' };
  f.repo.listLeads = async () => [lead];
  f.repo.updateLeadStatus = async (id, status) => ({ ...lead, status });
  const allowed = await f.handle(f.request('/leads')); assert.equal(allowed.status, 200); assert.equal((await allowed.json()).leads[0].phone, lead.phone);
  const changed = await f.handle(f.request('/leads/' + lead.id + '/status', { status: 'closed' })); assert.equal(changed.status, 200); assert.equal((await changed.json()).lead.status, 'closed');
  const worker = accountFixture('worker'); worker.repo.listLeads = () => assert.fail('Only managers may read callback records');
  assert.equal((await worker.handle(worker.request('/leads'))).status, 403);
  assert.equal((await worker.handle(worker.request('/leads/' + lead.id + '/status', { status: 'closed' }))).status, 403);
  assert.equal((await f.handle(f.request('/leads', undefined, false))).status, 401);
});

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
  for (const action of ['account.archive', 'account.restore', 'account.password.reset', 'account.activate']) {
    const f = accountFixture('worker');
    const response = await f.handle(f.request('/actions', { action, payload: { id: 'target', password: 'simple6' } }));
    assert.equal(response.status, 403, action);
    assert.equal((await response.json()).code, 'FORBIDDEN');
    assert.equal(f.calls.reset, 0); assert.equal(f.settings.size, 0);
  }
});

test('Edge manager state distinguishes profile-only staff while other roles cannot read login status', async () => {
  const manager=accountFixture('manager',{legacy:true});
  const result=await manager.handle(manager.request('/state'));
  assert.equal(result.status,200);
  const body=await result.json();
  assert.equal(body.users.find(user=>user.id==='target').loginEnabled,false);
  assert.equal(body.users.find(user=>user.id==='manager').loginEnabled,true);
  assert(!JSON.stringify(body).includes('auth-manager'));
  const worker=accountFixture('worker',{legacy:true});
  const other=await worker.handle(worker.request('/state'));
  assert.equal(other.status,200);
  assert((await other.json()).users.every(user=>user.loginEnabled===undefined));
});

test('Edge saves a legacy profile edit and role transition without inventing a login or resetting a password', async () => {
  const f=accountFixture('manager',{legacy:true});
  const result=await f.handle(f.request('/actions',{action:'account.update',payload:{id:'target',name:'همکار ویرایش‌شده',phone:'09123456789',role:'worker'}}));
  assert.equal(result.status,200);
  const body=await result.json(), person=body.state.users.find(user=>user.id==='target');
  assert.equal(person.name,'همکار ویرایش‌شده');
  assert.equal(person.role,'worker');
  assert.equal(person.loginEnabled,false);
  assert.equal(body.state.users.length,3);
  assert.equal(f.calls.reset,0);
});

test('Edge explicit activation keeps the same profile and turns on its login without leaking the new password', async () => {
  const f=accountFixture('manager',{legacy:true});
  const result=await f.handle(f.request('/actions',{action:'account.activate',payload:{id:'target',phone:'09123456789',username:'staff.one',password:'simple6'}}));
  assert.equal(result.status,200);
  const body=await result.json();
  assert.equal(body.result.id,'target');
  assert.equal(body.state.users.length,3);
  assert.equal(body.state.users.find(user=>user.id==='target').loginEnabled,true);
  assert.equal(body.state.users.find(user=>user.id==='target').username,'staff.one');
  assert(!JSON.stringify(body).includes('simple6'));
  assert.equal(f.calls.reset,0);
});
