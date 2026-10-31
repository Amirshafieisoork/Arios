import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeedState } from '../public/domain.mjs';
import { activateAccount, createAccount, updateAccount, archiveAccount, restoreAccount, resetAccountPassword, passwordLogin, authenticate } from '../supabase/functions/arios-api/auth.mjs';

const manager = { id: 'manager', role: 'manager' };
const PHONE = '+989123456789';
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

function fixture() {
  let state = createSeedState(), revision = 1, authSequence = 0;
  state.users.find(user => user.id === 'worker').phone = PHONE;
  const profiles = new Map(state.users.filter(user => user.id !== 'worker').map(user => [user.id, { auth_user_id: 'auth-' + user.id, domain_user_id: user.id, role: user.role }]));
  const authUsers = new Map(), settings = new Map(), calls = [], locks = new Set();
  const controls = { updateConflicts: 0, commitConflicts: 0, commitThrows: null, commitReplyNull: false, recoveryLookupFails: false, recoveryLookupEmpty: false };
  const repo = {
    rateLimit: async () => ({ allowed: true }),
    loadState: async () => ({ state: structuredClone(state), revision }),
    getProfileByDomainId: async id => structuredClone(profiles.get(id) || null),
    getProfile: async id => {
      if (controls.recoveryLookupFails) throw Error('Uncertain database read');
      if (controls.recoveryLookupEmpty) return null;
      return structuredClone([...profiles.values()].find(profile => profile.auth_user_id === id) || null);
    },
    getSetting: async key => structuredClone(settings.get(key) || null),
    setSetting: async (key, value) => settings.set(key, structuredClone(value)),
    deleteSetting: async key => settings.delete(key),
    acquireLock: async (name, token, lease) => {
      calls.push({ type: 'lock', name, lease });
      if (locks.has(name)) return false;
      locks.add(name); return true;
    },
    releaseLock: async name => { locks.delete(name); },
    updateAccount: async input => {
      calls.push({ type: 'update', authUserId: input.authUserId, id: input.domainUserId });
      assert.equal(input.expectedRevision, revision);
      const profile = profiles.get(input.domainUserId);
      assert.equal(input.authUserId, profile?.auth_user_id ?? null);
      if (controls.updateConflicts-- > 0) { revision++; return false; }
      state = structuredClone(input.state); revision++;
      if (profile) profile.role = input.role;
      return true;
    },
    commitAccount: async input => {
      calls.push({ type: 'commit', authUserId: input.authUserId, id: input.domainUserId });
      assert.equal(input.expectedRevision, revision);
      if (controls.commitConflicts-- > 0) {
        state.users.find(user => user.id === 'worker').department = 'ویرایش هم‌زمان';
        revision++; return false;
      }
      if (controls.commitThrows === 'before') throw Error('Uncertain commit');
      assert.equal(profiles.has(input.domainUserId), false);
      state = structuredClone(input.state); revision++;
      profiles.set(input.domainUserId, { auth_user_id: input.authUserId, domain_user_id: input.domainUserId, role: input.role });
      if (controls.commitThrows === 'after') throw Error('Response lost after commit');
      if (controls.commitReplyNull) return null;
      return true;
    },
  };
  const client = { auth: {
    getUser: async () => ({ data: { user: { id: 'activated-auth-' + authSequence } } }),
    admin: {
      createUser: async input => {
        const id = 'activated-auth-' + ++authSequence;
        calls.push({ type: 'create-auth', input, id }); authUsers.set(id, { id, email: input.email });
        return { data: { user: { id } } };
      },
      getUserById: async id => ({ data: { user: authUsers.get(id) } }),
      updateUserById: async () => { calls.push({ type: 'reset-auth' }); throw Error('This flow must never change an existing password'); },
      deleteUser: async id => { calls.push({ type: 'delete-auth', id }); authUsers.delete(id); return { data: { user: { id } } }; },
    },
  } };
  return { repo, client, profiles, authUsers, settings, calls, controls, locks, read: () => structuredClone(state), change: callback => { callback(state); revision++; } };
}

test('legacy staff can edit contact and role without creating Auth or losing historical data', async () => {
  const f = fixture(), before = f.read();
  const result = await updateAccount(f.client, f.repo, manager, { id: 'worker', phone: '۰۹۱۲۳۴۵۶۷۸۹', name: 'همکار قدیمی ویرایش‌شده', department: 'اجرا' });
  assert.equal(result.result.loginEnabled, false);
  assert.equal(result.result.id, 'worker'); assert.equal(result.result.phone, PHONE);
  assert.equal(f.read().users.find(user => user.id === 'worker').name, 'همکار قدیمی ویرایش‌شده');
  for (const key of ['projects', 'reports', 'materials', 'invoices', 'receipts']) assert.deepEqual(f.read()[key], before[key]);
  assert(f.calls.filter(call => call.type === 'update').every(call => call.authUserId === null));
  const changed = await updateAccount(f.client, f.repo, manager, { id: 'worker', role: 'accountant' });
  assert.equal(changed.result.role, 'accountant'); assert.equal(f.profiles.has('worker'), false);
  assert.equal(f.calls.some(call => call.type.includes('auth')), false);
  assert.equal(f.read().users.find(user => user.id === 'worker').hourlyRate, before.users.find(user => user.id === 'worker').hourlyRate);
});

test('profile-only archive and restore preserve identity and history without Auth settings or SDK writes', async () => {
  const f = fixture(), before = f.read();
  const archived = await archiveAccount(f.client, f.repo, manager, { id: 'worker' });
  assert(archived.result.deletedAt); assert.equal(archived.result.loginEnabled, false);
  const restored = await restoreAccount(f.client, f.repo, manager, { id: 'worker' });
  assert.equal(restored.result.deletedAt, undefined); assert.equal(restored.result.loginEnabled, false);
  for (const key of ['projects', 'reports', 'materials', 'invoices', 'receipts']) assert.deepEqual(f.read()[key], before[key]);
  assert.equal(f.settings.size, 0); assert.equal(f.calls.some(call => call.type.includes('auth')), false);
});

test('explicit activation creates one fresh private identity while preserving legacy ID, assignments and financial history', async () => {
  const f = fixture(), before = f.read(), oldPerson = before.users.find(user => user.id === 'worker');
  const result = await activateAccount(f.client, f.repo, manager, { id: 'worker', phone: '۰۹۱۲۳۴۵۶۷۸۹', username: 'legacy.worker', password: 'simple6' });
  assert.equal(result.result.id, 'worker'); assert.equal(result.result.role, oldPerson.role); assert.equal(result.result.loginEnabled, true);
  assert.equal(f.read().users.length, before.users.length); assert.equal(f.profiles.get('worker').domain_user_id, 'worker');
  for (const key of ['projects', 'reports', 'materials', 'invoices', 'receipts']) assert.deepEqual(f.read()[key], before[key]);
  const person = f.read().users.find(user => user.id === 'worker');
  assert.equal(person.hourlyRate, oldPerson.hourlyRate); assert.deepEqual(person.rateHistory, oldPerson.rateHistory);
  const creates = f.calls.filter(call => call.type === 'create-auth'); assert.equal(creates.length, 1);
  assert.match(creates[0].input.email, /^account\.[a-f0-9-]{36}@phone\.arios\.invalid$/);
  assert.notEqual(creates[0].input.email, oldPerson.email); assert.equal(creates[0].input.password, 'simple6');
  assert(!JSON.stringify(result).includes('simple6')); assert.equal(f.calls.some(call => call.type === 'reset-auth' || call.type === 'delete-auth'), false);
  assert.equal(f.locks.size, 0);
  const session = await passwordLogin({ client: f.client, repo: f.repo, payload: { identifier: 'legacy.worker', password: 'simple6' }, authUrl: 'https://qategfabulrkvdckzmqp.supabase.co', authKey: 'fixture-server-key', fetcher: async (url, options) => {
    assert.equal(JSON.parse(options.body).email, creates[0].input.email);
    return json({ access_token: 'activated-access', refresh_token: 'activated-refresh', user: { id: creates[0].id } });
  } });
  assert.equal(session.access_token, 'activated-access');
  const verified = await authenticate(new Request('https://arios.example/api/state', { headers: { Authorization: 'Bearer activated-access' } }), f.client, f.repo);
  assert.equal(verified.user.id, 'worker'); assert.equal(verified.user.role, oldPerson.role);
});

test('activation rejects staff, owner, archived, active, duplicate and invalid identities before creating Auth', async () => {
  for (const role of ['worker', 'customer', 'warehouse', 'accountant']) {
    const f = fixture();
    await assert.rejects(activateAccount(f.client, f.repo, { id: role, role }, { id: 'worker', phone: PHONE, password: 'simple6' }), error => error.status === 403);
    assert.equal(f.calls.some(call => call.type === 'create-auth'), false);
  }
  for (const [id, password, phone, expected] of [
    ['manager', 'simple6', PHONE, 'MANAGER_ROLE_PROTECTED'],
    ['customer', 'simple6', PHONE, 'ACCOUNT_ALREADY_ACTIVE'],
    ['worker', '', PHONE, 'INVALID_INPUT'],
    ['worker', 'simple6', '123', 'INVALID_PHONE'],
  ]) {
    const f = fixture();
    await assert.rejects(activateAccount(f.client, f.repo, manager, { id, phone, password }), error => error.code === expected);
    assert.equal(f.calls.some(call => call.type === 'create-auth'), false);
  }
  const archived = fixture(); await archiveAccount(archived.client, archived.repo, manager, { id: 'worker' });
  await assert.rejects(activateAccount(archived.client, archived.repo, manager, { id: 'worker', phone: PHONE, password: 'simple6' }), error => error.code === 'NOT_FOUND');
  const duplicate = fixture(); duplicate.change(state => { state.users.find(user => user.id === 'customer').phone = PHONE; });
  await assert.rejects(activateAccount(duplicate.client, duplicate.repo, manager, { id: 'worker', phone: PHONE, password: 'simple6' }), error => error.code === 'DUPLICATE_PHONE');
  const warehouse = fixture(); warehouse.change(state => { state.users.find(user => user.id === 'worker').role = 'warehouse'; });
  await assert.rejects(activateAccount(warehouse.client, warehouse.repo, manager, { id: 'worker', phone: PHONE, password: 'simple6' }), error => error.code === 'USERNAME_REQUIRED');
  for (const f of [archived, duplicate, warehouse]) assert.equal(f.calls.some(call => call.type === 'create-auth'), false);
});

test('activation retries state conflicts once per snapshot without duplicate Auth and never resets an existing login', async () => {
  const f = fixture(); f.controls.commitConflicts = 1;
  const result = await activateAccount(f.client, f.repo, manager, { id: 'worker', phone: PHONE, password: 'simple6' });
  assert.equal(result.result.id, 'worker'); assert.equal(f.read().users.find(user => user.id === 'worker').department, 'ویرایش هم‌زمان');
  assert.equal(f.calls.filter(call => call.type === 'create-auth').length, 1);
  assert.equal(f.calls.filter(call => call.type === 'commit').length, 2);
  await assert.rejects(activateAccount(f.client, f.repo, manager, { id: 'worker', phone: PHONE, password: 'another6' }), error => error.code === 'ACCOUNT_ALREADY_ACTIVE');
  assert.equal(f.calls.filter(call => call.type === 'create-auth').length, 1);
  assert.equal(f.calls.some(call => call.type === 'reset-auth'), false);
});

test('uncertain activation commits preserve fresh Auth identities while definite CAS exhaustion permits cleanup', async () => {
  const committed = fixture(); committed.controls.commitThrows = 'after';
  const recovered = await activateAccount(committed.client, committed.repo, manager, { id: 'worker', phone: PHONE, password: 'simple6' });
  assert.equal(recovered.result.loginEnabled, true); assert.equal(committed.authUsers.size, 1);
  assert.equal(committed.calls.some(call => call.type === 'delete-auth'), false);
  const rejected = fixture(); rejected.controls.commitConflicts = 5;
  await assert.rejects(activateAccount(rejected.client, rejected.repo, manager, { id: 'worker', phone: PHONE, password: 'simple6' }), error => error.code === 'STATE_CONFLICT');
  assert.equal(rejected.profiles.has('worker'), false); assert.equal(rejected.authUsers.size, 0);
  const created = rejected.calls.find(call => call.type === 'create-auth');
  assert.deepEqual(rejected.calls.filter(call => call.type === 'delete-auth').map(call => call.id), [created.id]);
  const uncertain = fixture(); uncertain.controls.commitThrows = 'before'; uncertain.controls.recoveryLookupFails = true;
  await assert.rejects(activateAccount(uncertain.client, uncertain.repo, manager, { id: 'worker', phone: PHONE, password: 'simple6' }), error => error.code === 'ACCOUNT_SETUP_PENDING');
  assert.equal(uncertain.calls.some(call => call.type === 'delete-auth'), false, 'An uncertain profile lookup never authorizes deleting an Auth user');
  const pending = fixture(); pending.controls.commitThrows = 'before';
  await assert.rejects(activateAccount(pending.client, pending.repo, manager, { id: 'worker', phone: PHONE, password: 'simple6' }), error => error.code === 'ACCOUNT_SETUP_PENDING');
  assert.equal(pending.authUsers.size, 1, 'An empty lookup after a failed RPC does not establish that the RPC cannot still commit');
  assert.equal(pending.calls.some(call => call.type === 'delete-auth'), false);
  const stale = fixture(); stale.controls.commitThrows = 'after'; stale.controls.recoveryLookupEmpty = true;
  await assert.rejects(activateAccount(stale.client, stale.repo, manager, { id: 'worker', phone: PHONE, password: 'simple6' }), error => error.code === 'ACCOUNT_SETUP_PENDING');
  assert.equal(stale.profiles.has('worker'), true);
  assert.equal(stale.authUsers.size, 1);
  assert.equal(stale.calls.some(call => call.type === 'delete-auth'), false, 'A stale empty recovery read cannot delete an identity attached by the original transaction');
  const malformed = fixture(); malformed.controls.commitReplyNull = true; malformed.controls.recoveryLookupEmpty = true;
  await assert.rejects(activateAccount(malformed.client, malformed.repo, manager, { id:'worker',phone:PHONE,password:'simple6' }), error=>error.code==='ACCOUNT_SETUP_PENDING');
  assert.equal(malformed.profiles.has('worker'),true);
  assert.equal(malformed.authUsers.size,1);
  assert.equal(malformed.calls.some(call=>call.type==='delete-auth'),false,'Only a definite boolean false response permits cleanup');
});

test('legacy reset gives an activation instruction and stale role gives a separate repair instruction', async () => {
  const f = fixture();
  await assert.rejects(resetAccountPassword(f.client, f.repo, manager, { id: 'worker', password: 'simple6' }), error => error.code === 'ACCOUNT_NEEDS_ACTIVATION' && /فعال/.test(error.message));
  f.profiles.set('worker', { auth_user_id: 'auth-worker', domain_user_id: 'worker', role: 'customer' });
  await assert.rejects(resetAccountPassword(f.client, f.repo, manager, { id: 'worker', password: 'simple6' }), error => error.code === 'ACCOUNT_PROFILE_MISMATCH');
  await updateAccount(f.client, f.repo, manager, { id: 'worker', phone: PHONE });
  assert.equal(f.profiles.get('worker').role, 'worker'); assert.equal(f.settings.size, 0);
  assert.equal(f.calls.some(call => call.type === 'reset-auth' || call.type === 'create-auth'), false);
});

test('fresh-account setup also preserves uncertain identities and cleans up only definite CAS failure', async () => {
  const payload = { name:'حساب تازه', phone:'+989123456788', role:'customer', password:'simple6' };
  for (const phase of ['before','after']) {
    const f=fixture(); f.controls.commitThrows=phase; f.controls.recoveryLookupEmpty=true;
    await assert.rejects(createAccount(f.client,f.repo,manager,payload),error=>error.code==='ACCOUNT_SETUP_PENDING');
    assert.equal(f.authUsers.size,1);
    assert.equal(f.calls.some(call=>call.type==='delete-auth'),false);
    assert.equal(f.read().users.some(user=>user.phone===payload.phone),phase==='after');
  }
  const definite=fixture(); definite.controls.commitConflicts=5;
  await assert.rejects(createAccount(definite.client,definite.repo,manager,payload),error=>error.code==='STATE_CONFLICT');
  assert.equal(definite.authUsers.size,0);
  assert.equal(definite.calls.filter(call=>call.type==='delete-auth').length,1);
  assert.equal(definite.read().users.some(user=>user.phone===payload.phone),false);
});
