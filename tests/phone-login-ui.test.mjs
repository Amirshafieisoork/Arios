import test from 'node:test';
import assert from 'node:assert/strict';

function setGlobal(t, name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
}
function element(extra = {}) {
  return { textContent: '', innerHTML: '', hidden: false, disabled: false, value: '', type: 'password', events: {}, addEventListener(name, callback) { this.events[name] = callback; }, setAttribute() {}, focus() {}, ...extra };
}
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

async function loginPage(t, { pathname, result, status = 200 }) {
  const nodes = new Map(), calls = [], assignments = [];
  const node = selector => { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); };
  const password = node('#login-password'); password.value = '123456';
  const form = node('#login-form');
  form.elements = { identifier: { value: ' ۰۹۱۲۱۲۳۴۵۶۷ ' } };
  form.querySelector = selector => node(selector);
  setGlobal(t, 'document', { querySelector: selector => ['#recovery-form','[data-forgot-password]','[data-back-to-login]'].includes(selector) ? null : node(selector) });
  setGlobal(t, 'location', { pathname, assign: value => assignments.push(value) });
  setGlobal(t, 'fetch', async (url, options) => { calls.push({ url, options }); return json(result, status); });
  await import('../web/login.mjs?ui-test=' + crypto.randomUUID());
  await form.events.submit({ preventDefault() {} });
  return { node, calls, assignments, password };
}

test('phone login follows the verified account role even when using the other portal entry page', async t => {
  for (const scenario of [
    { pathname: '/login/client', portal: 'client', role: 'worker', destination: 'team' },
    { pathname: '/login/team', portal: 'team', role: 'customer', destination: 'client' },
    { pathname: '/login/client', portal: 'client', role: 'manager', destination: 'team' },
    { pathname: '/login/team', portal: 'team', role: 'warehouse', destination: 'team', page: 'inventory' },
    { pathname: '/login/client', portal: 'client', role: 'accountant', destination: 'team', page: 'finance' },
  ]) await t.test(scenario.role, async sub => {
    const mounted = await loginPage(sub, { pathname: scenario.pathname, result: { user: { id: 'same-account', role: scenario.role }, portal: scenario.destination } });
    assert.equal(mounted.calls.length, 1);
    assert.equal(mounted.calls[0].url, '/api/login');
    assert.equal(mounted.calls[0].options.credentials, 'same-origin');
    assert.deepEqual(JSON.parse(mounted.calls[0].options.body), { identifier: '۰۹۱۲۱۲۳۴۵۶۷', password: '123456', portal: scenario.portal });
    assert.deepEqual(mounted.assignments, ['/portal/?portal=' + scenario.destination + '#' + (scenario.page || 'dashboard')]);
    assert.equal(mounted.password.value, '');
    assert.equal(mounted.node('#login-error').hidden, true);
  });
});

test('failed phone login leaves a retryable error and does not navigate', async t => {
  const mounted = await loginPage(t, { pathname: '/login/team', result: { code: 'INVALID_CREDENTIALS', error: 'private-provider-error' }, status: 401 });
  assert.deepEqual(mounted.assignments, []);
  assert.equal(mounted.password.value, '123456');
  assert.equal(mounted.node('[type="submit"]').disabled, false);
  assert.equal(mounted.node('#login-error').hidden, false);
  assert.match(mounted.node('#login-error').textContent, /شماره تماس یا رمز عبور/);
  assert(!mounted.node('#login-error').textContent.includes('private-provider-error'));
});

async function setupPage(t, passwordValue) {
  const nodes = new Map(), calls = [], assignments = [], replacements = [];
  const node = selector => { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); };
  node('#setup-password').value = passwordValue;
  node('#setup-confirm').value = passwordValue;
  const form = node('#setup-form');
  form.email = { value: ' owner@example.com ' };
  form.querySelector = selector => node(selector);
  setGlobal(t, 'document', { querySelector: node });
  setGlobal(t, 'location', { pathname: '/setup', search: '', hash: '#code=one-time-test-code', assign: value => assignments.push(value) });
  setGlobal(t, 'history', { replaceState: (...args) => replacements.push(args) });
  setGlobal(t, 'fetch', async (url, options) => { calls.push({ url, payload: JSON.parse(options.body) }); return json({ ok: true }); });
  await import('../web/setup.mjs?ui-test=' + crypto.randomUUID());
  await form.events.submit({ preventDefault() {} });
  return { node, calls, assignments, replacements };
}

test('owner setup accepts any chosen password without length or composition requirements and clears the setup URL', async t => {
  const mounted = await setupPage(t, '1');
  assert.deepEqual(mounted.calls, [
    { url: '/api/bootstrap', payload: { code: 'one-time-test-code', email: 'owner@example.com', password: '1' } },
    { url: '/api/login', payload: { email: 'owner@example.com', password: '1', portal: 'team' } },
  ]);
  assert.deepEqual(mounted.assignments, ['/portal/?portal=team#dashboard']);
  assert.deepEqual(mounted.replacements, [[null, '', '/setup']]);
  assert.equal(mounted.node('#setup-password').value, '');
  assert.equal(mounted.node('#setup-confirm').value, '');
});

test('owner setup still asks for a non-empty password before submitting anything', async t => {
  const mounted = await setupPage(t, '');
  assert.deepEqual(mounted.calls, []);
  assert.deepEqual(mounted.assignments, []);
  assert.equal(mounted.node('#setup-error').hidden, false);
  assert.match(mounted.node('#setup-error').textContent, /رمز عبور را وارد کنید/);
});
