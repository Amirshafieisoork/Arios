import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, phoneAuthEmail, loginIdentity } from '../public/identity.mjs';
import { applyAction, createSeedState, publicState, projectAccess } from '../public/domain.mjs';
import { createAccount, updateAccount, passwordLogin, passwordValue } from '../supabase/functions/arios-api/auth.mjs';

const PHONE = '+989123456789';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function fixture(initial = createSeedState()) {
  let state = structuredClone(initial), revision = 1;
  const calls = [], profiles = new Map(state.users.map(person => [person.id, { auth_user_id: `auth-${person.id}`, domain_user_id: person.id, role: person.role }]));
  const repo = {
    rateLimit: async () => ({ allowed: true }),
    loadState: async () => ({ state: structuredClone(state), revision }),
    getProfileByDomainId: async id => structuredClone(profiles.get(id) || null),
    getProfile: async id => [...profiles.values()].find(profile => profile.auth_user_id === id),
    commitAccount: async input => { assert.equal(input.expectedRevision, revision); state = structuredClone(input.state); revision++; profiles.set(input.domainUserId, { auth_user_id: input.authUserId, domain_user_id: input.domainUserId, role: input.role }); return true; },
    updateAccount: async input => { assert.equal(input.expectedRevision, revision); state = structuredClone(input.state); revision++; profiles.get(input.domainUserId).role = input.role; calls.push({ type: 'atomic-account-update', role: input.role }); return true; },
  };
  const client = { auth: { admin: {
    createUser: async input => { calls.push({ type: 'create-auth', input }); return { data: { user: { id: 'new-auth-account' } } }; },
    getUserById: async id => { calls.push({ type: 'private-auth-lookup', id }); return { data: { user: { id, email: 'existing-real-address@example.com' } } }; },
    deleteUser: async () => { throw Error('A successful update must not delete an Auth user.'); },
  } } };
  return { repo, client, calls, profiles, read: () => structuredClone(state) };
}

test('Iranian and international contact numbers normalize without requiring email or SMS', () => {
  for (const value of ['۰۹۱۲ ۳۴۵ ۶۷۸۹', '٠٩١٢٣٤٥٦٧٨٩', '00989123456789', '+98 (912) 345-6789', '989123456789', '9123456789']) assert.equal(normalizePhone(value), PHONE);
  assert.equal(normalizePhone('02112345678'), '+982112345678');
  assert.equal(normalizePhone('+442071838750'), '+442071838750');
  for (const value of ['', '123', '+9809123456789', '0912letters', '+1234567890123456']) assert.throws(() => normalizePhone(value));
  assert.equal(phoneAuthEmail(PHONE), 'phone.989123456789@phone.arios.invalid');
  assert.deepEqual(loginIdentity({ identifier: ' Manager@Example.com ' }), { email: 'manager@example.com' });
  assert.throws(() => loginIdentity({ email: phoneAuthEmail(PHONE) }));
});

test('new accounts accept any chosen password with a phone while private email aliases stay out of snapshots', async () => {
  const f = fixture();
  const result = await createAccount(f.client, f.repo, { id: 'manager', role: 'manager' }, { name: 'همکار جدید', phone: '۰۹۱۲۳۴۵۶۷۸۹', role: 'worker', password: '123456' });
  assert.equal(result.result.phone, PHONE);
  assert.equal(result.result.email, undefined);
  const created = f.calls.find(call => call.type === 'create-auth').input;
  assert.match(created.email, /^account\.[a-f0-9-]{36}@phone\.arios\.invalid$/); assert.equal(created.email_confirm, true);
  assert.equal(created.phone, undefined, 'No phone-provider/SMS flow is required.');
  assert.equal(JSON.stringify(publicState(f.read(), 'manager')).includes('@phone.arios.invalid'), false);
  assert.throws(() => passwordValue(''));
  assert.equal(passwordValue('12345'), '12345');
  assert.equal(passwordValue('1'), '1');
});

test('duplicate phone identities are rejected before creating a second Auth account', async () => {
  const state = createSeedState(); state.users.find(user => user.id === 'worker').phone = PHONE;
  const f = fixture(state);
  await assert.rejects(createAccount(f.client, f.repo, { id: 'manager', role: 'manager' }, { name: 'تکراری', phone: '09123456789', role: 'customer', password: '123456' }), error => error.code === 'DUPLICATE_PHONE');
  assert.equal(f.calls.length, 0);
});

test('changing a phone leaves an immutable Auth identity and allows that contact number on a different new account', async () => {
  const f = fixture(), usedEmails = new Set(); let authSequence = 0;
  f.client.auth.admin.createUser = async input => {
    f.calls.push({ type: 'create-auth', input });
    if (usedEmails.has(input.email)) return { error: { code: 'email_exists' } };
    usedEmails.add(input.email);
    return { data: { user: { id: 'new-auth-' + ++authSequence } } };
  };
  const first = await createAccount(f.client, f.repo, { id: 'manager', role: 'manager' }, { name: 'همکار نخست', phone: PHONE, role: 'worker', password: '123456' });
  await updateAccount(f.client, f.repo, { id: 'manager', role: 'manager' }, { id: first.result.id, phone: '09351234567', role: 'worker' });
  const second = await createAccount(f.client, f.repo, { id: 'manager', role: 'manager' }, { name: 'همکار دوم', phone: PHONE, role: 'customer', password: '123456' });
  assert.notEqual(first.result.id, second.result.id);
  assert.equal(usedEmails.size, 2);
  assert.equal(f.read().users.find(user => user.id === first.result.id).phone, '+989351234567');
  assert.equal(f.read().users.find(user => user.id === second.result.id).phone, PHONE);
});

test('customer can become a worker with project continuity and historical records preserved', async () => {
  const f = fixture(), before = f.read();
  const result = await updateAccount(f.client, f.repo, { id: 'manager', role: 'manager' }, { id: 'customer', name: 'مشتری و همکار', phone: PHONE, role: 'worker' });
  const state = f.read(), previousProjects = before.projects.filter(project => project.customerId === 'customer');
  assert.equal(result.result.role, 'worker'); assert.equal(f.profiles.get('customer').role, 'worker');
  for (const previous of previousProjects) { const project = state.projects.find(item => item.id === previous.id); assert.equal(project.customerId, null); assert(project.memberIds.includes('customer')); assert(projectAccess(state, 'customer', project.id)); }
  for (const collection of ['reports', 'invoices', 'receipts', 'materials']) assert.deepEqual(state[collection], before[collection]);
  assert.equal(f.calls.some(call => call.type === 'create-auth'), false);
});

test('worker can become customer without stealing another customer project or losing wages/history', async () => {
  const state = createSeedState();
  const report = applyAction(state, 'worker', 'report.create', { projectId: 'p1', date: '2026-10-20', start: '08:00', end: '09:00', breakMinutes: 0, description: 'اجرای تست', output: 'تکمیل' });
  const f = fixture(state), previous = f.read(), personBefore = previous.users.find(user => user.id === 'worker');
  const result = await updateAccount(f.client, f.repo, { id: 'manager', role: 'manager' }, { id: 'worker', role: 'customer', phone: PHONE });
  const after = f.read(), personAfter = after.users.find(user => user.id === 'worker');
  assert.equal(personAfter.role, 'customer'); assert.equal(f.profiles.get('worker').role, 'customer');
  assert.deepEqual(personAfter.rateHistory, personBefore.rateHistory); assert.equal(personAfter.hourlyRate, personBefore.hourlyRate);
  assert(after.projects.every(project => !project.memberIds.includes('worker')));
  assert.equal(after.projects.find(project => project.id === 'p1').customerId, previous.projects.find(project => project.id === 'p1').customerId);
  assert(result.result.warnings.length > 0);
  assert.deepEqual(after.reports, previous.reports);
  const approved = applyAction(after, 'manager', 'report.review', { id: report.id, status: 'approved' });
  assert.equal(approved.status, 'approved'); assert.equal(approved.laborCost, approved.rate);
  assert(publicState(after, 'manager').reports.some(item => item.id === report.id));
});

test('only managers can edit roles and contact numbers, and owner-manager role stays protected', async () => {
  const f = fixture(), before = f.read();
  await assert.rejects(updateAccount(f.client, f.repo, { id: 'worker', role: 'worker' }, { id: 'worker', role: 'customer', phone: PHONE }), error => error.status === 403);
  await assert.rejects(updateAccount(f.client, f.repo, { id: 'manager', role: 'manager' }, { id: 'manager', role: 'worker', phone: PHONE }), error => error.code === 'MANAGER_ROLE_PROTECTED');
  assert.deepEqual(f.read(), before);
});

test('phone edits on an existing email account resolve privately and authenticate against its existing Auth identity', async () => {
  const state = createSeedState(); state.users.find(user => user.id === 'worker').phone = PHONE;
  const f = fixture(state), calls = [];
  const session = await passwordLogin({ client: f.client, repo: f.repo, payload: { phone: '09123456789', password: '123456' }, authUrl: 'https://qategfabulrkvdckzmqp.supabase.co', authKey: 'fixture-server-key', fetcher: async (url, options) => {
    calls.push({ url, options }); assert.equal(url, 'https://qategfabulrkvdckzmqp.supabase.co/auth/v1/token?grant_type=password');
    assert.deepEqual(JSON.parse(options.body), { email: 'existing-real-address@example.com', password: '123456' });
    return json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600, user: { id: 'auth-worker', email: 'existing-real-address@example.com' } });
  } });
  assert.deepEqual(session, { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600 });
  assert.equal(JSON.stringify(session).includes('existing-real-address'), false); assert.equal(calls.length, 1);
});

test('unknown phone or wrong password returns the same safe failure and never exposes email mappings', async () => {
  const f = fixture();
  await assert.rejects(passwordLogin({ client: f.client, repo: f.repo, payload: { phone: PHONE, password: '123456' }, authUrl: 'https://qategfabulrkvdckzmqp.supabase.co', authKey: 'fixture-server-key', fetcher: async () => json({ error: 'private upstream details' }, 400) }), error => error.status === 401 && error.code === 'INVALID_CREDENTIALS' && !error.message.includes('upstream'));
});

test('public project publication is explicit and private projects stay unpublished by default', () => {
  const state = createSeedState(), project = state.projects[0];
  assert.equal(project.publicVisible, undefined);
  applyAction(state, 'manager', 'project.update', { id: project.id, publicVisible: true, publicTitle: 'عنوان عمومی', publicSummary: 'شرح عمومی بدون مشخصات مشتری' });
  const visible = publicState(state, 'manager').projects.find(item => item.id === project.id);
  assert.equal(visible.publicVisible, true); assert.equal(visible.publicTitle, 'عنوان عمومی');
  const before = structuredClone(state);
  assert.throws(() => applyAction(state, 'worker', 'project.update', { id: project.id, publicVisible: true }));
  assert.deepEqual(state, before);
});
