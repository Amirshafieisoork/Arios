import test from 'node:test';
import assert from 'node:assert/strict';
import { renderVoiceAudio, validateVoiceAudio, wireVoiceAudio, audioPlaybackActive } from '../public/voice-player.mjs';
import { api } from '../public/api.mjs';
import { renderVoice, wireVoice, stopVoice, voiceDraftText } from '../public/voice.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const playback = id => ({ url: `/api/voice/audio/file/${id}`, expiresAt: new Date(Date.now() + 300000).toISOString(), fileName: 'voice.ogg', mimeType: 'audio/ogg' });
const signed = suffix => ({ url: `https://qategfabulrkvdckzmqp.supabase.co/storage/v1/object/sign/arios-audio/worker/draft/audio.ogg?token=fictitious-${suffix}`, expiresAt: new Date(Date.now() + 300000).toISOString(), fileName: 'voice.ogg', mimeType: 'audio/ogg' });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function setGlobal(t, name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
}

class Element extends EventTarget {
  constructor() { super(); this.dataset = {}; this.attributes = new Map(); this.disabled = false; this.hidden = false; this.textContent = ''; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
}
class Player extends Element {
  constructor() { super(); this.paused = true; this.ended = false; this.error = null; this.currentTime = 0; this.duration = 100; this.playCalls = 0; this.loadCalls = 0; }
  set src(value) { this.setAttribute('src', value); this.error = null; this.currentTime = 0; }
  get src() { return this.getAttribute('src'); }
  async play() { this.playCalls += 1; if (this.playError) throw this.playError; this.paused = false; this.dispatchEvent(new Event('play')); }
  pause() { const changed = !this.paused; this.paused = true; if (changed) this.dispatchEvent(new Event('pause')); }
  load() { this.loadCalls += 1; if (this.getAttribute('src')) this.dispatchEvent(new Event('loadedmetadata')); }
}
function fixture(ids = ['draft-one']) {
  const blocks = ids.map(id => {
    const block = new Element(); block.dataset.voiceAudio = id;
    const elements = { '[data-voice-audio-player]': new Player(), '[data-voice-audio-load]': new Element(), '[data-voice-audio-stop]': new Element(), '[data-voice-audio-download]': new Element(), '[data-voice-audio-status]': new Element() };
    elements['[data-voice-audio-stop]'].disabled = true;
    elements['[data-voice-audio-download]'].hidden = true;
    block.querySelector = selector => elements[selector];
    return Object.assign(block, { elements });
  });
  const root = { querySelectorAll: selector => selector === '[data-voice-audio]' ? blocks : selector === '[data-voice-audio-player]' ? blocks.map(b => b.querySelector('[data-voice-audio-player]')) : [] };
  const elements = blocks.map(block => ({ block, player: block.querySelector('[data-voice-audio-player]'), button: block.querySelector('[data-voice-audio-load]'), stop: block.querySelector('[data-voice-audio-stop]'), download: block.querySelector('[data-voice-audio-download]'), status: block.querySelector('[data-voice-audio-status]') }));
  return { root, elements };
}

test('original Telegram/upload audio is playable in failed, ready and submitted drafts without embedding a signed URL', () => {
  for (const status of ['pending', 'processing', 'failed', 'ready', 'submitted']) {
    const html = renderVoiceAudio({ id: 'draft-"<one>', source: 'telegram', status, audio: { available: true, expiresAt: '2099-01-01T00:00:00Z' }, url: signed('unused').url }, { escape, date: value => value });
    assert.match(html, /<audio[^>]*controls preload="none" crossorigin="anonymous"/);
    assert.match(html, /data-voice-audio="draft-&quot;&lt;one&gt;"/);
    assert.match(html, /data-voice-audio-stop/);
    assert(!html.includes('fictitious-'));
    assert(!html.includes('src='));
  }
  assert.equal(renderVoiceAudio({ source: 'text' }, { escape, date: String }), '');
  assert.match(renderVoiceAudio({ source: 'upload', audio: { available: false, expiresAt: '2000-01-01T00:00:00Z' } }, { escape, date: String }), /مهلت نگه‌داری/);
});

test('fresh same-origin audio paths accept only a safe draft ID and no browser credentials or query', () => {
  assert.equal(validateVoiceAudio(playback('telegram_19991865')).url, '/api/voice/audio/file/telegram_19991865');
  for (const url of [
    '/api/voice/audio/file/', '/api/voice/audio/file/' + 'a'.repeat(121),
    '/api/voice/audio/file/../private', '/api/voice/audio/file/a/b',
    '/api/voice/audio/file/%2e%2e', '/api/voice/audio/file/a%2fb',
    '/api/voice/audio/file/a?token=secret', '/api/voice/audio/file/a#fragment',
    '//untrusted.example/api/voice/audio/file/a',
    'https://untrusted.example/api/voice/audio/file/a',
    'https://user:password@arios-rouge.vercel.app/api/voice/audio/file/a',
    ' /api/voice/audio/file/a', '/api/voice/audio/file/a\n',
  ]) assert.throws(() => validateVoiceAudio({ ...playback('a'), url }), /INVALID_AUDIO_URL/);
  for (const expiresAt of ['2000-01-01T00:00:00Z', 'invalid']) assert.throws(() => validateVoiceAudio({ ...playback('a'), expiresAt }), /INVALID_AUDIO_URL/);
});

test('fresh HTTPS signed private storage audio remains supported during deployment rollover', () => {
  assert.equal(validateVoiceAudio(signed('valid')).fileName, 'voice.ogg');
  for (const change of [
    { url: 'javascript:alert(1)' }, { url: signed('insecure').url.replace('https:', 'http:') },
    { url: signed('credential').url.replace('https://', 'https://user:password@') },
    { url: 'https://untrusted.example.com/storage/v1/object/sign/arios-audio/a.ogg' },
    { url: signed('foreign-project').url.replace('qategfabulrkvdckzmqp', 'another-project') },
    { url: signed('unsigned').url.split('?')[0] },
    { url: signed('wrong-bucket').url.replace('arios-audio/', 'public-files/') },
    { expiresAt: '2000-01-01T00:00:00Z' }, { expiresAt: 'invalid' },
  ]) assert.throws(() => validateVoiceAudio({ ...signed('invalid'), ...change }), /INVALID_AUDIO_URL/);
});

test('downloaded work-report dates use the Persian display formatter instead of raw ISO storage dates', () => {
  const text = voiceDraftText({ status: 'ready', source: 'text', transcript: 'فعالیت واقعی', fields: { projectId: 'p1', date: '2026-10-22', description: 'نصب دوربین' } }, { projectName: () => 'پروژهٔ آریوس', date: value => { assert.equal(value, '2026-10-22'); return '۱۴۰۵/۰۷/۳۰'; } });
  assert.match(text, /تاریخ: ۱۴۰۵\/۰۷\/۳۰/);
  assert(!text.includes('2026-10-22'));
  assert.match(text, /نصب دوربین/);
});

test('requesting playback uses the authenticated application API and sends only a draft ID', async t => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/voice/audio');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { id: 'draft-one' });
    return new Response(JSON.stringify(playback('draft-one')), { headers: { 'Content-Type': 'application/json' } });
  };
  assert.equal((await api.voiceAudio('draft-one')).url, '/api/voice/audio/file/draft-one');
});

test('audio loading and playing are active states, one player sounds at a time, and stop resets time', async () => {
  const { root, elements: [first, second] } = fixture(['first', 'second']);
  let resolveFirst;
  const calls = [];
  const dispose = wireVoiceAudio(root, { getAudio: id => { calls.push(id); return id === 'first' ? new Promise(resolve => { resolveFirst = resolve; }) : Promise.resolve(playback('second')); } });
  first.button.dispatchEvent(new Event('click'));
  first.button.dispatchEvent(new Event('click'));
  assert.deepEqual(calls, ['first']);
  assert.equal(audioPlaybackActive(root), true);
  assert.equal(first.button.disabled, true);
  resolveFirst(playback('first'));
  await tick();
  assert.equal(first.player.paused, false);
  assert.equal(first.download.hidden, false);
  assert.equal(first.stop.disabled, false);
  assert.equal(audioPlaybackActive(root), true);
  second.button.dispatchEvent(new Event('click'));
  await tick();
  assert.equal(first.player.paused, true);
  assert.equal(second.player.paused, false);
  second.player.currentTime = 30;
  second.stop.dispatchEvent(new Event('click'));
  assert.equal(second.player.currentTime, 0);
  assert.equal(audioPlaybackActive(root), false);
  dispose();
});

test('a failed/expired media response can be renewed without persisting it, and resumes the listening position', async () => {
  const { root, elements: [view] } = fixture();
  let count = 0;
  const dispose = wireVoiceAudio(root, { getAudio: async () => { count += 1; return playback('draft-one'); } });
  view.button.dispatchEvent(new Event('click'));
  await tick();
  view.player.currentTime = 24;
  view.player.error = { code: 2 };
  view.player.pause();
  view.player.dispatchEvent(new Event('error'));
  assert.match(view.button.textContent, /تلاش دوباره/);
  assert.equal(view.status.dataset.error, 'true');
  view.button.dispatchEvent(new Event('click'));
  await tick();
  assert.equal(count, 2);
  assert.equal(view.player.src, '/api/voice/audio/file/draft-one');
  assert.equal(view.player.currentTime, 24);
  dispose();
  assert.equal(view.player.getAttribute('src'), null);
  assert.equal(view.download.getAttribute('href'), null);
  assert.equal(view.download.hidden, true);
  assert.equal(view.player.paused, true);
});

test('browser autoplay restrictions keep native controls ready, while private API failures never reveal raw details', async () => {
  const first = fixture();
  first.elements[0].player.playError = Object.assign(new Error('Blocked'), { name: 'NotAllowedError' });
  const dispose = wireVoiceAudio(first.root, { getAudio: async () => playback('manual') });
  first.elements[0].button.dispatchEvent(new Event('click'));
  await tick();
  assert.match(first.elements[0].status.textContent, /دکمهٔ پخش داخل نوار/);
  assert.equal(first.elements[0].player.src, '/api/voice/audio/file/manual');
  dispose();
  const second = fixture();
  const disposeFailed = wireVoiceAudio(second.root, { getAudio: async () => { throw Object.assign(new Error('raw-private-upstream-details'), { status: 410, code: 'AUDIO_EXPIRED' }); } });
  second.elements[0].button.dispatchEvent(new Event('click'));
  await tick();
  assert.match(second.elements[0].status.textContent, /مهلت نگه‌داری/);
  assert(!second.elements[0].status.textContent.includes('raw-private'));
  assert.equal(second.elements[0].player.src, null);
  disposeFailed();
});

test('same-origin playback preserves authentication, permission and unavailable-file errors safely', async () => {
  for (const [status, code, message] of [
    [401, 'UNAUTHORIZED', /دوباره وارد حساب/],
    [403, 'FORBIDDEN', /اجازهٔ شنیدن/],
    [404, 'AUDIO_NOT_AVAILABLE', /در دسترس نیست/],
    [410, 'AUDIO_EXPIRED', /مهلت نگه‌داری/],
  ]) {
    const { root, elements: [view] } = fixture();
    const dispose = wireVoiceAudio(root, { getAudio: async () => { throw Object.assign(new Error('private-storage-or-auth-detail'), { status, code }); } });
    view.button.dispatchEvent(new Event('click'));
    await tick();
    assert.match(view.status.textContent, message);
    assert(!view.status.textContent.includes('private-storage-or-auth-detail'));
    assert.equal(view.player.src, null);
    assert.equal(view.download.hidden, true);
    assert.equal(view.button.disabled, false);
    dispose();
  }
});

test('navigating away while a signed URL is loading never attaches it to a detached player', async () => {
  const { root, elements: [view] } = fixture();
  let resolve;
  const dispose = wireVoiceAudio(root, { getAudio: () => new Promise(r => { resolve = r; }) });
  view.button.dispatchEvent(new Event('click'));
  dispose();
  resolve(signed('detached'));
  await tick();
  assert.equal(view.player.src, null);
  assert.equal(view.player.playCalls, 0);
});

test('automatic voice refresh preserves an active player and a deferred manual refresh runs after pause', async t => {
  const { root, elements: [view] } = fixture();
  const user = { id: 'voice-player-refresh-test', role: 'worker', name: 'عضو تیم' };
  root.dataset = { voiceUser: user.id };
  const reload = new Element();
  let poll, fetched = 0, refreshed = 0;
  const doc = {
    visibilityState: 'visible',
    querySelector: selector => selector === '[data-voice-user]' ? root : null,
    querySelectorAll: selector => selector === '[data-voice-reload]' ? [reload] : root.querySelectorAll(selector),
  };
  setGlobal(t, 'document', doc);
  setGlobal(t, 'setInterval', callback => { poll = callback; return 123; });
  setGlobal(t, 'clearInterval', () => {});
  t.after(stopVoice);
  const state = { user, users: [user], projects: [] };
  const ctx = { e: escape, icon: () => '', n: String, date: String, projectName: () => '', personName: () => '', refresh: async () => { refreshed += 1; }, api: { isStatic: false, voiceAudio: async () => signed('refresh'), voice: async () => { fetched += 1; return { drafts: [], telegram: { configured: false }, integration: { aiConfigured: true } }; } } };
  wireVoice(state, ctx);
  await tick();
  assert.equal(fetched, 1);
  assert.equal(refreshed, 1);
  view.button.dispatchEvent(new Event('click'));
  await tick();
  poll();
  await tick();
  assert.equal(fetched, 1);
  assert.equal(refreshed, 1);
  reload.dispatchEvent(new Event('click'));
  await tick();
  assert.equal(fetched, 2);
  assert.equal(refreshed, 1);
  assert.equal(view.player.paused, false);
  view.player.pause();
  await tick();
  assert.equal(refreshed, 2);
});

test('manager receives a real service diagnostic action and voice headings have no terminal full stop', () => {
  const ctx = { e: escape, icon: () => '', n: String, date: String, projectName: () => '', personName: () => '', api: { isStatic: false } };
  const manager = { id: 'voice-diagnostic-manager-test', role: 'manager', name: 'مدیر' };
  const html = renderVoice({ user: manager, users: [manager], projects: [] }, ctx);
  assert.match(html, /data-voice-test/);
  assert.match(html, /بررسی واقعی سرویس/);
  assert.match(html, /صوت اصلی حداکثر هفت روز/);
  for (const heading of html.matchAll(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gs)) assert(!heading[1].trim().endsWith('.'));
  const worker = { ...manager, id: 'voice-diagnostic-worker-test', role: 'worker' };
  assert(!renderVoice({ user: worker, users: [worker], projects: [] }, ctx).includes('data-voice-test'));
});

test('service diagnostics use an authenticated same-origin POST with no provider credentials', async t => {
  setGlobal(t, 'fetch', async (url, options) => {
    assert.equal(url, '/api/integrations/test');
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'same-origin');
    assert.deepEqual(JSON.parse(options.body), {});
    return new Response(JSON.stringify({ ok: false, provider: 'OpenAI', chat: { ok: true, message: 'موفق' }, transcription: { ok: false, code: 'AI_QUOTA', message: 'اعتبار سرویس کافی نیست' } }), { headers: { 'Content-Type': 'application/json' } });
  });
  const diagnostic = await api.integrationsTest();
  assert.equal(diagnostic.chat.ok, true);
  assert.equal(diagnostic.transcription.code, 'AI_QUOTA');
});
