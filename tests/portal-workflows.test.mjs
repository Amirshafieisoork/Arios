import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeedState, publicState } from '../public/domain.mjs';
import { portalNotifications, projectWorkers, reportProjects } from '../public/portal-workflows.mjs';
import { renderOperations, wireOperations } from '../public/operations.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const context = extra => ({ e: escape, n: String, money: String, date: String, icon: value => `<i>${escape(value)}</i>`, badge: String, personName: String, projectName: String, api: { isStatic: false }, capabilities: { ai: true, supabaseAuth: true }, authMode: 'supabase', refresh: async () => {}, ...extra });
function useDocument(t, document) {
  const previous = globalThis.document;
  globalThis.document = document;
  t.after(() => previous === undefined ? delete globalThis.document : globalThis.document = previous);
}

test('report entry offers only projects with an eligible assigned worker and never changes membership', () => {
  const seed = createSeedState(), manager = publicState(seed, 'manager');
  manager.projects.push({ id: 'unassigned', memberIds: [] });
  const before = structuredClone(manager);
  assert(!reportProjects(manager).some(project => project.id === 'unassigned'));
  assert.deepEqual(projectWorkers(manager, 'p1').map(person => person.id).sort(), ['worker', 'worker2']);
  const worker = publicState(seed, 'worker');
  assert(reportProjects(worker).every(project => project.memberIds.includes('worker')));
  assert.deepEqual(projectWorkers(worker, 'p1').map(person => person.id), ['worker']);
  assert.deepEqual(reportProjects(publicState(seed, 'customer')), []);
  assert.deepEqual(projectWorkers(manager, 'missing'), []);
  assert.deepEqual(manager, before);
});

test('follow-up center respects project scope, internal messages and worker finance boundaries', () => {
  const seed = createSeedState();
  seed.messages.push({ id: 'private-team-note', projectId: 'p1', authorId: 'worker', internal: true, text: 'internal-only-marker', createdAt: '2026-10-21T10:00:00Z' });
  seed.messages.push({ id: 'other-customer-message', projectId: 'p3', authorId: 'manager', internal: false, text: 'other-project-marker', createdAt: '2026-10-21T11:00:00Z' });
  const customer = portalNotifications(publicState(seed, 'customer'));
  assert(customer.every(item => item.projectId === 'p1'));
  assert(!JSON.stringify(customer).includes('internal-only-marker'));
  assert(!JSON.stringify(customer).includes('other-project-marker'));
  const worker = portalNotifications(publicState(seed, 'worker'));
  assert(!worker.some(item => item.kind === 'invoice'));
  assert(!worker.some(item => item.kind === 'report'));
  const manager = portalNotifications(publicState(seed, 'manager'));
  assert(manager.some(item => item.id === 'message:private-team-note'));
  assert(manager.some(item => item.kind === 'invoice'));
});

test('every operational navigation page has a working data view and role-specific access', () => {
  const seed = createSeedState(), manager = publicState(seed, 'manager');
  for (const page of ['reports', 'finance', 'inventory', 'support', 'assistant', 'team', 'analytics', 'settings', 'notifications']) {
    const html = renderOperations(page, manager, context());
    assert.equal(typeof html, 'string', page);
    assert(!/TODO|به‌زودی|ساخته نشده/.test(html), page);
    assert(html.includes('<h1>') || html.includes('<h2>'), page);
  }
  for (const page of ['inventory', 'team', 'analytics']) {
    assert.match(renderOperations(page, publicState(seed, 'customer'), context()), /این بخش برای نقش شما در دسترس نیست/);
  }
});

test('general assistant works before any project exists and unavailable service has a real settings path', () => {
  const state = publicState(createSeedState(), 'manager');
  state.user.id = 'empty-general-assistant'; state.projects = [];
  const html = renderOperations('assistant', state, context());
  assert.match(html, /گفت‌وگوی عمومی آریوس/);
  assert.match(html, /<textarea[^>]*maxlength="4000"[^>]*>/);
  assert(!/<textarea[^>]*disabled/.test(html));
  assert(!/<button[^>]*type="submit"[^>]*disabled/.test(html));
  assert(!html.includes('data-ai-escalate'));
  const offline = renderOperations('assistant', state, context({ capabilities: { ai: false } }));
  assert.match(offline, /href="#voice"/);
  assert.match(offline, /type="submit" disabled/);
});

test('assistant retry preserves failed input without adding it twice to provider history', async t => {
  const state = publicState(createSeedState(), 'manager');
  state.user.id = 'assistant-retry-case'; state.projects = [];
  const events = {}, requests = [], textarea = { value: 'چگونه از گزارش کار استفاده کنم؟', addEventListener() {}, focus() {} };
  const form = { querySelector: () => textarea, addEventListener: (name, callback) => { events[name] = callback; } };
  const mount = { dataset: { assistantUser: state.user.id, assistantProject: '' } };
  useDocument(t, { querySelector: selector => ({ '[data-ai-form]': form, '[data-assistant-user]': mount }[selector] || null), querySelectorAll: () => [] });
  const ctx = context({ api: { isStatic: false, assistant: async payload => { requests.push(payload); if (requests.length === 1) throw Error('سرویس موقتاً در دسترس نیست'); return { answer: 'گزارش را از بخش گزارش‌های کار ثبت کنید', live: true, sources: [] }; } }, toast() {} });
  renderOperations('assistant', state, ctx);
  wireOperations('assistant', state, ctx);
  await events.submit({ preventDefault() {} });
  const failed = renderOperations('assistant', state, ctx);
  assert.match(failed, /role="alert"/);
  assert.match(failed, /متن پیام حفظ شده است/);
  assert(failed.includes(textarea.value));
  assert(!failed.includes('chat-bubble user'));
  await events.submit({ preventDefault() {} });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].history, []);
  assert(!Object.hasOwn(requests[1], 'projectId'));
  const success = renderOperations('assistant', state, ctx);
  assert.equal((success.match(/class="chat-bubble user"/g) || []).length, 1);
  assert.equal((success.match(/class="chat-bubble assistant"/g) || []).length, 1);
  assert(!success.includes('role="alert"'));
});

test('customer payment coordination sends a project message and cannot record a payment', async t => {
  const state = publicState(createSeedState(), 'customer');
  const invoice = state.invoices.find(item => item.amount > item.paid);
  let click, modal, action;
  const button = { dataset: { coordinatePayment: invoice.id }, addEventListener: (_, callback) => { click = callback; } };
  useDocument(t, { querySelector: () => null, querySelectorAll: selector => selector === '[data-coordinate-payment]' ? [button] : [] });
  const ctx = context({ modal: value => { modal = value; }, mutate: async (name, payload) => { action = { name, payload }; } });
  const html = renderOperations('finance', state, ctx);
  assert(html.includes('data-coordinate-payment'));
  assert(html.includes('data-invoice-details'));
  assert(!html.includes('data-receipt='));
  wireOperations('finance', state, ctx); click();
  assert(modal.body.includes(escape(invoice.title)));
  const data = new FormData(); data.set('projectId', invoice.projectId); data.set('text', 'درخواست هماهنگی تسویه');
  await modal.onSubmit(data);
  assert.deepEqual(action, { name: 'message.send', payload: { projectId: invoice.projectId, text: 'درخواست هماهنگی تسویه', internal: false } });
});
