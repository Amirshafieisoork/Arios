import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeedState } from '../public/domain.mjs';
import {
  authenticate, archiveAccount, restoreAccount, createAccount, passwordLogin,
  requestPasswordReset, listPasswordResetRequests, resetAccountPassword,
} from '../supabase/functions/arios-api/auth.mjs';

const SESSION_OLD = '11111111-1111-4111-8111-111111111111';
const SESSION_NEW = '22222222-2222-4222-8222-222222222222';
const token = sessionId => 'verified.' + Buffer.from(JSON.stringify({ session_id: sessionId })).toString('base64url') + '.signature';
const manager = { id: 'manager', role: 'manager' };
const request = accessToken => new Request('https://arios.example/api/state', { headers: { Authorization: 'Bearer ' + accessToken } });
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

function fixture() {
  let state = createSeedState(), revision = 1;
  state.users.find(user => user.id === 'worker').phone = '+989123456789';
  state.users.find(user => user.id === 'worker').username = 'warehouse.one';
  const settings = new Map(), sessions = new Map([[SESSION_OLD, '2000-01-01T00:00:00.000Z'], [SESSION_NEW, '2100-01-01T00:00:00.000Z']]);
  const calls = [], profiles = new Map(state.users.map(user => [user.id, { auth_user_id: 'auth-' + user.id, domain_user_id: user.id, role: user.role }]));
  const controls = { resetMode: 'success', failFinalSecurityWrite: false, invalidAuth: false };
  const repo = {
    rateLimit: async (key, limit, windowMs) => { calls.push({ type: 'rate', key, limit, windowMs }); return { allowed: true }; },
    loadState: async () => ({ state: structuredClone(state), revision }),
    getProfile: async authUserId => [...profiles.values()].find(profile => profile.auth_user_id === authUserId),
    getProfileByDomainId: async id => structuredClone(profiles.get(id)),
    getSetting: async key => structuredClone(settings.get(key)),
    setSetting: async (key, value) => {
      if (controls.failFinalSecurityWrite && key.startsWith('auth-security:') && value.blocked === false) throw new Error('Storage temporarily unavailable');
      settings.set(key, structuredClone(value));
    },
    deleteSetting: async key => settings.delete(key),
    acquireLock: async (name, lockToken, leaseMs) => { calls.push({ type: 'lock', name, lockToken, leaseMs }); return true; },
    releaseLock: async name => { calls.push({ type: 'unlock', name }); },
    authSessionValid: async (authUserId, sessionId, validAfter) => {
      calls.push({ type: 'session-check', authUserId, sessionId });
      return authUserId === 'auth-worker' && sessions.has(sessionId) && Date.parse(sessions.get(sessionId)) > Date.parse(validAfter);
    },
    updateAccount: async input => {
      assert.equal(input.expectedRevision, revision);
      state = structuredClone(input.state); revision++;
      profiles.get(input.domainUserId).role = input.role;
      return true;
    },
    commitAccount: async input => {
      state = structuredClone(input.state); revision++;
      profiles.set(input.domainUserId, { auth_user_id: input.authUserId, domain_user_id: input.domainUserId, role: input.role });
      return true;
    },
  };
  const client = { auth: {
    getUser: async () => controls.invalidAuth ? { error: { status: 401 } } : { data: { user: { id: 'auth-worker' } } },
    admin: {
      createUser: async values => { calls.push({ type: 'create-auth', values }); return { data: { user: { id: 'new-auth' } } }; },
      getUserById: async id => ({ data: { user: { id, email: 'private-existing-email@example.com' } } }),
      updateUserById: async (id, values) => {
        calls.push({ type: 'reset-auth', id, values });
        assert.equal(settings.get('auth-security:worker')?.blocked, true, 'Application access is blocked before external password mutation');
        if (controls.resetMode === 'network-error') throw new Error('Uncertain private upstream detail');
        if (controls.resetMode === 'known-error') return { error: { status: 422, message: 'Private provider error' } };
        return { data: { user: { id } } };
      },
    },
  } };
  return { repo, client, settings, calls, controls, read: () => structuredClone(state) };
}

test('recovery requests normalize identifiers, avoid enumeration and do not queue unknown or archived accounts', async () => {
  const f = fixture();
  const known = await requestPasswordReset(f.repo, { identifier: '۰۹۱۲۳۴۵۶۷۸۹' });
  const unknown = await requestPasswordReset(f.repo, { identifier: '09999999999' });
  assert.deepEqual(known, unknown);
  await requestPasswordReset(f.repo, { identifier: 'Warehouse.One' });
  assert.equal(f.settings.get('password-reset-requests').length, 1, 'Alternative identifiers cannot duplicate a pending account request');
  assert.equal(f.settings.get('password-reset-requests')[0].userId, 'worker');
  assert(!JSON.stringify(known).includes('worker'));
  assert(f.calls.some(call => call.type === 'rate' && call.key === 'password-reset-request:global'));
  const listed = await listPasswordResetRequests(f.repo, manager);
  assert.equal(listed.requests.length, 1);
  await assert.rejects(listPasswordResetRequests(f.repo, { id: 'worker', role: 'worker' }), error => error.status === 403);
  await archiveAccount(f.client, f.repo, manager, { id: 'worker' });
  assert.deepEqual(await requestPasswordReset(f.repo, { identifier: '09123456789' }), known);
  assert.equal((await listPasswordResetRequests(f.repo, manager)).requests.length, 0);
});

test('manager reset changes only the Auth password, resolves requests and rejects both old and refreshed-old sessions', async () => {
  const f = fixture();
  await requestPasswordReset(f.repo, { identifier: '09123456789' });
  const before = f.read();
  const reset = await resetAccountPassword(f.client, f.repo, manager, { id: 'worker', password: 'simple6' });
  assert.deepEqual(reset.result, { id: 'worker', ok: true, sessionsRevoked: true });
  assert.deepEqual(f.read(), before, 'No password or Auth metadata enters the domain data');
  assert.deepEqual(f.calls.find(call => call.type === 'reset-auth').values, { password: 'simple6' });
  assert(f.calls.filter(call => call.type === 'lock' && call.name.startsWith('account-security:')).every(call => call.leaseMs >= 300000));
  assert(!JSON.stringify(reset).includes('simple6'));
  assert(!JSON.stringify([...f.settings]).includes('simple6'));
  assert.equal((await listPasswordResetRequests(f.repo, manager)).requests.length, 0);
  for (const access of [token(SESSION_OLD), token(SESSION_OLD) + 'refreshed']) {
    await assert.rejects(authenticate(request(access), f.client, f.repo), error => error.status === 401 && error.code === 'INVALID_SESSION');
  }
  const accepted = await authenticate(request(token(SESSION_NEW)), f.client, f.repo);
  assert.equal(accepted.user.id, 'worker');
  assert(f.calls.filter(call => call.type === 'session-check').every(call => call.authUserId === 'auth-worker'));
});

test('reset authorization protects the owner and refuses staff, archived or short-password targets before Auth mutation', async () => {
  const f = fixture();
  for (const role of ['worker', 'customer', 'warehouse', 'accountant']) {
    await assert.rejects(resetAccountPassword(f.client, f.repo, { id: role, role }, { id: 'worker', password: 'simple6' }), error => error.status === 403);
  }
  await assert.rejects(resetAccountPassword(f.client, f.repo, manager, { id: 'manager', password: 'simple6' }), error => error.code === 'MANAGER_ROLE_PROTECTED');
  await assert.rejects(resetAccountPassword(f.client, f.repo, manager, { id: 'worker', password: '12345' }));
  await archiveAccount(f.client, f.repo, manager, { id: 'worker' });
  await assert.rejects(resetAccountPassword(f.client, f.repo, manager, { id: 'worker', password: 'simple6' }), error => error.status === 404);
  assert.equal(f.calls.filter(call => call.type === 'reset-auth').length, 0);
});

test('known reset rejection restores the prior policy and uncertain Auth outcome stays closed until manager retry', async () => {
  const f = fixture(), previous = { blocked: false, validAfter: '1999-01-01T00:00:00.000Z' };
  f.settings.set('auth-security:worker', previous);
  f.controls.resetMode = 'known-error';
  await assert.rejects(resetAccountPassword(f.client, f.repo, manager, { id: 'worker', password: 'simple6' }), error => error.code === 'PASSWORD_RESET_FAILED' && !error.message.includes('Private'));
  assert.deepEqual(f.settings.get('auth-security:worker'), previous);
  f.controls.resetMode = 'network-error';
  await assert.rejects(resetAccountPassword(f.client, f.repo, manager, { id: 'worker', password: 'simple6' }), error => error.code === 'PASSWORD_RESET_PENDING' && !error.message.includes('private'));
  assert.equal(f.settings.get('auth-security:worker').blocked, true);
  await assert.rejects(authenticate(request(token(SESSION_OLD)), f.client, f.repo), error => error.code === 'INVALID_SESSION');
  await assert.rejects(authenticate(request(token(SESSION_NEW)), f.client, f.repo), error => error.code === 'INVALID_SESSION');
  f.controls.resetMode = 'success';
  await resetAccountPassword(f.client, f.repo, manager, { id: 'worker', password: 'again6' });
  assert.equal((await authenticate(request(token(SESSION_NEW)), f.client, f.repo)).user.id, 'worker');
});

test('failed final security persistence remains closed until a manager retries the reset', async () => {
  const f = fixture(); f.controls.failFinalSecurityWrite = true;
  await assert.rejects(resetAccountPassword(f.client, f.repo, manager, { id: 'worker', password: 'simple6' }));
  assert.equal(f.settings.get('auth-security:worker').blocked, true);
  assert.equal(f.settings.get('auth-security:worker').blockUntil, undefined, 'A timed unblock cannot admit a reset-race session');
  await assert.rejects(authenticate(request(token(SESSION_NEW)), f.client, f.repo), error => error.code === 'INVALID_SESSION');
  f.controls.failFinalSecurityWrite = false;
  await resetAccountPassword(f.client, f.repo, manager, { id: 'worker', password: 'again6' });
  assert.equal((await authenticate(request(token(SESSION_NEW)), f.client, f.repo)).user.id, 'worker');
});

test('archive cuts access, restore requires a new session and history remains intact', async () => {
  const f = fixture(), before = f.read();
  await archiveAccount(f.client, f.repo, manager, { id: 'worker' });
  assert(f.read().users.find(user => user.id === 'worker').deletedAt);
  for (const name of ['projects', 'reports', 'materials', 'invoices', 'receipts']) assert.deepEqual(f.read()[name], before[name]);
  await assert.rejects(authenticate(request(token(SESSION_NEW)), f.client, f.repo), error => error.status === 403);
  await restoreAccount(f.client, f.repo, manager, { id: 'worker' });
  assert(!f.read().users.find(user => user.id === 'worker').deletedAt);
  await assert.rejects(authenticate(request(token(SESSION_OLD)), f.client, f.repo), error => error.code === 'INVALID_SESSION');
  assert.equal((await authenticate(request(token(SESSION_NEW)), f.client, f.repo)).user.id, 'worker');
});

test('warehouse accounts require a unique username and can sign in privately by that username', async () => {
  const f = fixture();
  await assert.rejects(createAccount(f.client, f.repo, manager, { role: 'warehouse', name: 'انباردار', phone: '09351234567', password: 'simple6' }));
  assert.equal(f.calls.filter(call => call.type === 'create-auth').length, 0);
  const result = await createAccount(f.client, f.repo, manager, { role: 'warehouse', name: 'انباردار', username: 'stock.arios', phone: '09351234567', password: 'simple6' });
  assert.equal(result.result.username, 'stock.arios'); assert.equal(result.result.role, 'warehouse');
  await assert.rejects(createAccount(f.client, f.repo, manager, { role: 'accountant', name: 'حسابدار', username: 'STOCK.ARIOS', phone: '09351234568', password: 'simple6' }), error => error.code === 'DUPLICATE_USERNAME');
  // Existing phone/email accounts keep their Auth identity when adding username login.
  const login = await passwordLogin({ client: f.client, repo: f.repo, payload: { identifier: 'Warehouse.One', password: 'simple6' }, authUrl: 'https://qategfabulrkvdckzmqp.supabase.co', authKey: 'test-server-key', fetcher: async (_url, init) => {
    assert.deepEqual(JSON.parse(init.body), { email: 'private-existing-email@example.com', password: 'simple6' });
    return json({ user: { id: 'auth-worker' }, access_token: token(SESSION_NEW), refresh_token: 'test-refresh', expires_in: 3600 });
  } });
  assert(login.access_token); assert(!JSON.stringify(login).includes('private-existing-email'));
});

test('invalid Auth tokens cannot reach the session cutoff RPC', async () => {
  const f = fixture(); f.controls.invalidAuth = true;
  f.settings.set('auth-security:worker', { validAfter: '2026-10-22T00:00:00.000Z' });
  await assert.rejects(authenticate(request(token(SESSION_NEW)), f.client, f.repo), error => error.code === 'INVALID_SESSION');
  assert.equal(f.calls.filter(call => call.type === 'session-check').length, 0);
});
