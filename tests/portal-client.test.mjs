import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../public/api.mjs';
import { renderOperations, wireOperations } from '../public/operations.mjs';
import { createSeedState, publicState } from '../public/domain.mjs';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const fakeSignedURL = 'https://arios-test.supabase.co/storage/v1/object/upload/sign/voice-reports/draft/audio.ogg?token=test-signed-upload';
function setGlobal(t, name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
}

test('Supabase portal uploads audio directly to signed storage without forwarding portal credentials', async t => {
  const calls = [];
  const file = new File([new Uint8Array([79, 103, 103, 83])], 'voice.ogg', { type: 'audio/ogg' });
  setGlobal(t, 'fetch', async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (url === '/api/session') return json({ user: { id: 'worker' }, authMode: 'supabase' });
    if (url === '/api/voice/upload-url') {
      assert.deepEqual(JSON.parse(options.body), { fileName: file.name, mimeType: 'audio/ogg', size: 4, projectId: 'project-one' });
      assert.equal(options.credentials, 'same-origin');
      return json({ draftId: 'draft-one', uploadUrl: fakeSignedURL, token: 'test-signed-upload', path: 'draft/audio.ogg' });
    }
    if (String(url) === fakeSignedURL) {
      const headers = new Headers(options.headers);
      assert.equal(options.method, 'PUT');
      assert.equal(options.body, file);
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error');
      assert.equal(headers.get('Content-Type'), 'audio/ogg');
      assert.equal(headers.get('x-upsert'), 'false');
      assert.equal(headers.has('Authorization'), false);
      assert.equal(headers.has('apikey'), false);
      assert.equal(headers.has('Cookie'), false);
      return json({ Key: 'draft/audio.ogg' });
    }
    if (url === '/api/voice/upload-complete') {
      assert.deepEqual(JSON.parse(options.body), { id: 'draft-one' });
      return json({ id: 'draft-one', status: 'ready' });
    }
    assert.fail('Unexpected client request');
  });
  await api.session();
  const result = await api.voiceUpload(file, 'project-one');
  assert.equal(result.status, 'ready');
  assert.deepEqual(calls.map(call => call.url), ['/api/session', '/api/voice/upload-url', fakeSignedURL, '/api/voice/upload-complete']);
  assert.equal(calls.some(call => call.options.body instanceof FormData), false);
});

test('failed or unsafe signed uploads do not finalize a report or expose upstream error details', async t => {
  const calls = [];
  let uploadUrl = fakeSignedURL;
  setGlobal(t, 'fetch', async (url, options = {}) => {
    calls.push(String(url));
    if (url === '/api/session') return json({ user: { id: 'worker' }, authMode: 'supabase' });
    if (url === '/api/voice/upload-url') {
      assert.equal(JSON.parse(options.body).mimeType, 'audio/ogg');
      return json({ draftId: 'draft-one', uploadUrl });
    }
    if (String(url) === fakeSignedURL) return json({ error: 'raw-storage-error-with-signed-token' }, 403);
    assert.fail('Failed upload must not be finalized');
  });
  await api.session();
  const file = new File(['voice'], 'voice.opus');
  await assert.rejects(api.voiceUpload(file), error => !error.message.includes('raw-storage-error') && /بارگذاری صوت کامل نشد/.test(error.message));
  uploadUrl = 'http://arios-test.supabase.co/insecure';
  await assert.rejects(api.voiceUpload(file), /نشانی امن بارگذاری/);
  assert.equal(calls.includes('/api/voice/upload-complete'), false);
  assert.equal(calls.includes(uploadUrl), false);
  const before = calls.length;
  await assert.rejects(api.voiceUpload({ name: 'too-large.ogg', size: 20 * 1024 * 1024 + 1, type: 'audio/ogg' }), /۲۰ مگابایت/);
  assert.equal(calls.length, before);
});

test('standalone and legacy hosted portals retain multipart voice upload behavior', async t => {
  const file = new File(['voice'], 'voice.ogg', { type: 'audio/ogg' });
  setGlobal(t, 'fetch', async (url, options = {}) => {
    if (url === '/api/session') return json({ user: { id: 'worker' }, authMode: 'chatgpt' });
    assert.equal(url, '/api/voice/upload');
    assert(options.body instanceof FormData);
    assert.equal(options.body.get('file').name, 'voice.ogg');
    assert.equal(options.body.get('projectId'), 'project-one');
    assert.equal(new Headers(options.headers).has('Content-Type'), false);
    return json({ id: 'legacy-draft', status: 'ready' });
  });
  await api.session();
  assert.equal((await api.voiceUpload(file, 'project-one')).id, 'legacy-draft');
});

test('Supabase accounts use phone and a simple initial password while legacy ChatGPT remains passwordless', async t => {
  const state = publicState(createSeedState(), 'manager');
  let click, modal, mutation;
  const button = { addEventListener: (_, handler) => { click = handler; } };
  setGlobal(t, 'document', { querySelector: () => null, querySelectorAll: selector => selector === '[data-new-account]' ? [button] : [] });
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const ctx = { e: escape, n: String, money: String, date: String, personName: String, projectName: String, authMode: 'supabase', capabilities: { hosted: true, supabaseAuth: true }, api: { isStatic: false }, modal: value => { modal = value; }, mutate: async (action, payload) => { mutation = { action, payload }; } };
  assert(!renderOperations('team', state, ctx).includes('ChatGPT'));
  wireOperations('team', state, ctx);
  click();
  assert.match(modal.body, /name="password"/);
  assert.match(modal.body, /minlength="1" maxlength="128"/);
  assert.match(modal.body, /name="phone" type="tel"/);
  assert(!modal.body.includes('name="email"'));
  assert(!modal.body.includes('ChatGPT'));
  const data = new FormData();
  for (const [key, value] of Object.entries({ name: 'عضو تازه', phone: '۰۹۱۲۱۲۳۴۵۶۷', role: 'worker', password: '123456' })) data.set(key, value);
  data.append('projectIds', 'p1');
  await modal.onSubmit(data);
  assert.equal(mutation.action, 'account.create');
  assert.deepEqual(mutation.payload, { name: 'عضو تازه', phone: '۰۹۱۲۱۲۳۴۵۶۷', role: 'worker', username: '', password: '123456', projectIds: ['p1'], department: '', skill: '' });
  ctx.authMode = 'chatgpt';
  ctx.capabilities.supabaseAuth = false;
  wireOperations('team', state, ctx);
  click();
  assert(!modal.body.includes('name="password"'));
  assert.match(modal.body, /ChatGPT/);
});

test('manager edits the same account between customer and coworker without replacing its password or history', async t => {
  const state = publicState(createSeedState(), 'manager');
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const edits = new Map(), mutations = [];
  const buttons = ['worker', 'customer'].map(id => ({ dataset: { editAccount: id }, addEventListener: (_, callback) => edits.set(id, callback) }));
  setGlobal(t, 'document', { querySelector: () => null, querySelectorAll: selector => selector === '[data-edit-account]' ? buttons : [] });
  let modal;
  const ctx = { e: escape, n: String, money: String, date: String, personName: String, projectName: String, authMode: 'supabase', capabilities: { hosted: true, supabaseAuth: true }, api: { isStatic: false }, modal: value => { modal = value; }, mutate: async (action, payload) => mutations.push({ action, payload }) };
  const before = structuredClone(state);
  wireOperations('team', state, ctx);
  for (const [id, role] of [['worker', 'customer'], ['customer', 'worker']]) {
    edits.get(id)();
    assert.match(modal.body, /name="phone" type="tel"/);
    assert(!modal.body.includes('name="email"'));
    assert(!modal.body.includes('name="password"'));
    const form = new FormData();
    for (const [name, value] of Object.entries({ name: 'نام اصلاح‌شده', phone: '09121234567', role, department: 'اجرا', skill: 'شبکه' })) form.set(name, value);
    await modal.onSubmit(form);
    assert.deepEqual(mutations.at(-1), { action: 'account.update', payload: { id, name: 'نام اصلاح‌شده', phone: '09121234567', role, username: '', department: 'اجرا', skill: 'شبکه' } });
  }
  assert.deepEqual(state, before);
  for (const role of ['worker', 'customer']) {
    edits.clear();
    wireOperations('team', publicState(createSeedState(), role), ctx);
    assert.equal(edits.size, 0, 'only a manager may wire account editing');
  }
});

test('team shows phone call links for coworkers and customers while preserving old account email privately', () => {
  const state = publicState(createSeedState(), 'manager');
  for (const person of state.users.filter(user => ['worker', 'customer'].includes(user.role))) {
    person.email = `${person.id}-private-email@example.com`;
    person.phone = person.id === 'worker' ? '+989121234567' : '';
  }
  const ctx = { e: String, n: String, money: String, date: String, authMode: 'supabase', capabilities: { hosted: true, supabaseAuth: true } };
  const html = renderOperations('team', state, ctx);
  assert.match(html, /href="tel:\+989121234567"/);
  assert.match(html, /شماره تماس ثبت نشده/);
  assert(!html.includes('private-email@example.com'));
  assert.equal((html.match(/data-edit-account=/g) || []).length, state.users.filter(user => ['manager', 'worker', 'customer', 'warehouse', 'accountant'].includes(user.role) && !user.deletedAt).length);
  assert(!html.includes('data-new-profile'));
});

async function mountPortal(t, { session, state, search = '', hash = '#dashboard' }) {
  const app = { innerHTML: '' }, replacements = [], assignments = [], calls = [], buttons = [];
  setGlobal(t, 'location', { search, hash, replace: value => replacements.push(value), assign: value => assignments.push(value), reload() {} });
  setGlobal(t, 'window', { addEventListener() {}, scrollTo() {} });
  setGlobal(t, 'document', {
    querySelector: selector => selector === '#app' ? app : null,
    querySelectorAll: selector => selector === '[data-action]' ? buttons : [],
  });
  const logout = { dataset: { action: 'logout' }, addEventListener: (_, callback) => { logout.click = callback; } };
  buttons.push(logout);
  setGlobal(t, 'fetch', async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/session') return json(session);
    if (url === '/api/state') return json(state);
    if (url === '/api/logout') return json({ ok: true });
    assert.fail('Unexpected portal request');
  });
  await import('../public/app.mjs?portal-test=' + crypto.randomUUID());
  await new Promise(resolve => setTimeout(resolve, 0));
  return { app, replacements, assignments, calls, logout };
}

test('anonymous Supabase portals choose their matching client or team login route', async t => {
  for (const scenario of [
    { search: '?portal=client', expected: '/login/client' },
    { search: '', expected: '/login/team' },
    { search: '', portal: 'client', expected: '/login/client' },
  ]) {
    await t.test(scenario.expected + scenario.search, async sub => {
      const mounted = await mountPortal(sub, { session: { user: null, authMode: 'supabase', portal: scenario.portal }, search: scenario.search });
      assert.deepEqual(mounted.replacements, [scenario.expected]);
      assert.equal(mounted.calls.some(call => call.url === '/api/state'), false);
      assert(!mounted.app.innerHTML.includes('signin-with-chatgpt'));
    });
  }
});

test('authenticated customer portal has public navigation and logs out through the application session', async t => {
  const state = publicState(createSeedState(), 'customer');
  const mounted = await mountPortal(t, { session: { user: state.user, authMode: 'supabase', demo: false, capabilities: { hosted: true, supabaseAuth: true, ai: false } }, state, search: '?portal=client' });
  assert.match(mounted.app.innerHTML, /class="brand" href="\/"/);
  assert.match(mounted.app.innerHTML, /معرفی و فعالیت‌های آریوس/);
  assert(!mounted.app.innerHTML.includes('href="#voice"'));
  assert(!mounted.app.innerHTML.includes('href="#team"'));
  await mounted.logout.click();
  assert.deepEqual(mounted.assignments, ['/']);
  const logout = mounted.calls.find(call => call.url === '/api/logout');
  assert.equal(logout.options.method, 'POST');
  assert.equal(logout.options.credentials, 'same-origin');
  assert.equal(mounted.calls.some(call => String(call.url).includes('signout-with-chatgpt')), false);
});
