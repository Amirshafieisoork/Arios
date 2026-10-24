import test from 'node:test';
import assert from 'node:assert/strict';
import {callbackPhoneIn, redactContactNumbers, requestPublicAnswer, requestPublicLead, initPublicChat} from '../web/chat.mjs';

const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
const flush = () => new Promise(resolve => setImmediate(resolve));

test('a callback deliberately sends contact data only to its own endpoint and requires a real acceptance', async () => {
  const lead = {phone: '۰۹۱۲۱۲۳۴۵۶۷', name: ' مینا ', message: ' دوربین فروشگاه ', requestId: 'callback-request'};
  const result = await requestPublicLead(lead, {fetcher: async (url, options) => {
    assert.equal(url, '/api/public-leads');
    assert.equal(options.credentials, 'same-origin');
    assert.deepEqual(JSON.parse(options.body), {phone: '09121234567', name: 'مینا', message: 'دوربین فروشگاه', requestId: 'callback-request', consent: true});
    assert(!new Headers(options.headers).has('Authorization'));
    return json({accepted: true, lead: {id: 'lead-1'}}, 201);
  }});
  assert.equal(result.lead.id, 'lead-1');
  for (const body of [{ok: true}, {accepted: false, lead: {id: 'lead-1'}}, {accepted: true}, {lead: {id: 'lead-1'}}]) {
    await assert.rejects(requestPublicLead(lead, {fetcher: async () => json(body)}), /تأیید نشد/);
  }
  await assert.rejects(requestPublicLead(lead, {fetcher: async () => json({code: 'PHONE_INVALID'}, 400)}), /شماره تماس/);
  await assert.rejects(requestPublicLead(lead, {fetcher: async () => json({error: 'internal database identifier'}, 500)}), error => !error.message.includes('database'));
});

test('Persian and formatted phone numbers are removed from both AI message and history', async () => {
  assert.equal(callbackPhoneIn('تماس: ۰۹۱۲ ۱۲۳ ۴۵۶۷'), '0912 123 4567');
  assert.equal(callbackPhoneIn('تلفن +98 (21) 1234-5678'), '+98 (21) 1234-5678');
  assert.equal(callbackPhoneIn('در تاریخ ۱۴۰۵/۰۸/۰۲ برای ۳ اتاق'), '');
  assert(!redactContactNumbers('09121234567').includes('0912'));
  await requestPublicAnswer('با من در ۰۹۱۲۱۲۳۴۵۶۷ تماس بگیرید', [{role: 'user', content: '+98 (21) 1234-5678'}], {fetcher: async (_url, options) => {
    const payload = JSON.parse(options.body);
    assert(!JSON.stringify(payload).includes('0912'));
    assert(!JSON.stringify(payload).includes('۰۹۱۲'));
    assert(!JSON.stringify(payload).includes('1234'));
    assert.match(payload.message, /شماره تماس/);
    return json({answer: 'می‌توانید درخواست تماس ثبت کنید.', live: false, mode: 'guide'});
  }});
});

function mount(t, fetcher) {
  class Element {
    constructor() { this.value = ''; this.textContent = ''; this.dataset = {}; this.hidden = false; this.disabled = false; this.listeners = {}; this.nodes = {}; }
    querySelector(selector) { return this.nodes[selector] ||= new Element(); }
    querySelectorAll() { return []; }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    emit(name, event = {}) { for (const fn of this.listeners[name] || []) fn({preventDefault() {}, currentTarget: this, target: this, ...event}); }
    setAttribute(name, value) { this[name] = value; }
    focus() { this.focused = true; }
    scrollIntoView() { this.scrolled = true; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    reportValidity() { return true; }
  }
  const dialog = new Element(), callback = dialog.querySelector('[data-callback-form]');
  callback.elements = {phone: new Element(), name: new Element(), message: new Element()};
  const overrides = {document: {activeElement: null, querySelector: selector => selector === '#arios-chat' ? dialog : null, querySelectorAll: () => []}, window: {addEventListener() {}}, location: {hash: '#chat'}, history: {pushState() {}, replaceState() {}}, requestAnimationFrame: fn => fn(), matchMedia: () => ({matches: true}), HTMLElement: Element, fetch: fetcher};
  const descriptors = new Map(Object.keys(overrides).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(overrides)) Object.defineProperty(globalThis, key, {value, configurable: true, writable: true});
  t.after(() => { for (const [key, descriptor] of descriptors) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]; });
  return {chat: initPublicChat(), dialog, callback, phone: callback.elements.phone, fields: callback.querySelector('fieldset'), status: dialog.querySelector('[data-callback-status]'), error: dialog.querySelector('[data-callback-error]')};
}

test('a phone typed in chat opens the callback form locally without requesting an AI response', async t => {
  const calls = [], ui = mount(t, async (...args) => { calls.push(args); throw Error('unexpected fetch'); });
  await ui.chat.ask('برای دوربین مشاوره می‌خواهم، شماره من ۰۹۱۲ ۱۲۳ ۴۵۶۷ است');
  assert.equal(calls.length, 0);
  assert.equal(ui.phone.value, '0912 123 4567');
  assert(!ui.callback.elements.message.value.includes('0912'));
  assert.match(ui.status.textContent, /تأیید و ثبت کنید/);
  assert(!ui.status.textContent.includes('شماره ثبت شد'));
  assert.equal(ui.dialog.querySelector('[data-callback-card]').scrolled, true);
});

test('callback waits for persistence, blocks duplicate clicks, and reuses its request ID after a lost response', async t => {
  let finish;
  const calls = [], ui = mount(t, async (_url, options) => { calls.push(JSON.parse(options.body)); return new Promise(resolve => { finish = resolve; }); });
  ui.phone.value = '09121234567';
  ui.callback.emit('submit'); ui.callback.emit('submit');
  assert.equal(calls.length, 1);
  assert.equal(ui.fields.disabled, true);
  assert.equal(ui.status.textContent, '');
  finish(json({accepted: false}, 500)); await flush();
  assert.equal(ui.error.hidden, false);
  assert.equal(ui.fields.disabled, false);
  assert(!ui.status.textContent.includes('شماره ثبت شد'));
  await ui.chat.ask('برای مشاوره با شماره 09351234567 تماس بگیرید');
  assert.equal(ui.phone.value, '09121234567', 'an uncertain submission keeps its exact payload until the visitor edits the form');
  ui.callback.emit('submit');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  finish(json({accepted: true, lead: {id: 'lead-persisted'}}, 200)); await flush();
  assert.equal(ui.status.textContent, 'شماره ثبت شد؛ تیم آریوس برای مشاوره با شما تماس می‌گیرد');
  assert.equal(ui.fields.hidden, true);
  assert.equal(ui.phone.value, '');
  ui.callback.emit('submit');
  assert.equal(calls.length, 2);
});
