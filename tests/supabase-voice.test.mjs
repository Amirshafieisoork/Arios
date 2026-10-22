import test from 'node:test';
import assert from 'node:assert/strict';
import { handleVoice, getConfig, safeConfig, syncTelegram } from '../supabase/functions/arios-api/voice-service.mjs';
import { createSeedState, DomainError } from '../supabase/functions/arios-api/domain.mjs';

const TOKEN = '123456:arios_test_token_123456789012345';
const KEY = 'arios_test_only_ai_secret';
const TRANSCRIPT = 'در مجتمع آفتاب در تاریخ 2026-10-20 از ساعت 09:00 تا 17:00 کار کردم و 30 دقیقه استراحت داشتم. چهار دوربین نصب و فعال شد.';
const OGG = new Uint8Array([79, 103, 103, 83, 0, 1, 2, 3]);
const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const clone = value => structuredClone(value);

function fixture() {
  let state = createSeedState();
  const settings = new Map([['integrations', { aiBaseUrl: 'https://api.avalai.ir/v1', aiApiKey: KEY, aiModel: 'gpt-4o-mini', transcriptionModel: 'whisper-1', telegramBotToken: TOKEN, botId: '123456', botUsername: 'AriosTestBot' }]]);
  const drafts = new Map(), links = new Map(), codes = new Map(), updates = new Map(), objects = new Map();
  const mock = { fetchCalls: [], extractionFailure: false, telegramFailure: null, incoming: [], storageDeletes: [], signedPaths: [], playbackSigns: [], storageWrites: [], downloadCount: 0, rateAllowed: true };
  let locked = false;
  const repo = {
    async loadState() { return { state: clone(state), revision: 1 }; },
    async mutateState(callback) { const next = clone(state), result = await callback(next); state = next; return { result, state: clone(state) }; },
    async getSetting(key) { return clone(settings.get(key) ?? null); },
    async setSetting(key, value) { settings.set(key, clone(value)); },
    async rateLimit() { return { allowed: mock.rateAllowed }; },
    async listDrafts(userId = null, limit = 100) { return [...drafts.values()].filter(row => !userId || row.user_id === userId).slice(0, limit).map(clone); },
    async getDraft(id) { return clone(drafts.get(id) ?? null); },
    async createDraft({ id, userId, source, status = 'pending', transcript = '', fields = {}, fileId = null, sourceMetadata = {}, storagePath = null, createdAt = new Date().toISOString() }) {
      if (drafts.has(id)) throw new DomainError('Duplicate draft', 409, 'DUPLICATE_RECORD');
      const row = { id, user_id: userId, source, status, transcript, fields, source_metadata: sourceMetadata, storage_path: storagePath, file_id: fileId, created_at: createdAt, updated_at: createdAt, claim: null, claim_until: 0 };
      drafts.set(id, clone(row)); return clone(row);
    },
    async updateDraft(id, patch, { claim } = {}) { const row = drafts.get(id); if (!row || (claim !== undefined && row.claim !== claim)) return null; Object.assign(row, clone(patch)); return clone(row); },
    async claimDraft(id, claim, leaseMs) { const row = drafts.get(id); if (!row || ['ready', 'submitted'].includes(row.status) || (row.status === 'processing' && row.claim_until > Date.now())) return null; Object.assign(row, { status: 'processing', claim, claim_until: Date.now() + leaseMs }); return clone(row); },
    async pendingTelegramDrafts(limit) { return [...drafts.values()].filter(row => row.source === 'telegram' && row.status === 'pending').slice(0, limit).map(clone); },
    async expiredUploadDrafts(before) { return [...drafts.values()].filter(row => row.source === 'upload' && !row.transcript && ['pending', 'failed'].includes(row.status) && row.created_at < before).map(clone); },
    async completedUploadDrafts(before) { return [...drafts.values()].filter(row => row.source === 'upload' && row.transcript && row.storage_path && row.created_at < before).map(clone); },
    async expiredAudioDrafts(before) { return [...drafts.values()].filter(row => ['upload', 'telegram'].includes(row.source) && row.storage_path && row.created_at < before && (row.status !== 'processing' || row.claim_until < Date.now())).map(clone); },
    async listTelegramLinks(userId = null) { return [...links.values()].filter(row => !userId || row.user_id === userId).map(clone); },
    async getTelegramLink(id) { return clone(links.get(String(id)) ?? null); },
    async createLinkCode(value) { for (const [key, row] of codes) if (row.userId === value.userId) codes.delete(key); codes.set(value.codeHash, clone(value)); },
    async consumeLinkCode({ codeHash, telegramUserId, chatId }) { const code = codes.get(codeHash); if (!code || code.expiresAt < new Date().toISOString()) return null; const linked = links.get(telegramUserId); if (linked && linked.user_id !== code.userId) throw new DomainError('Conflict', 409, 'LINK_CONFLICT'); const row = { telegram_user_id: telegramUserId, user_id: code.userId, chat_id: chatId }; links.set(telegramUserId, row); codes.delete(codeHash); return clone(row); },
    async unlinkTelegram(userId) { for (const [key, row] of links) if (row.user_id === userId) links.delete(key); },
    async ingestUpdates(values) { let inserted = 0, offset = Number(settings.get('telegram_offset') || 0); for (const value of values) { if (!updates.has(value.update_id)) { updates.set(value.update_id, { update_id: value.update_id, payload: clone(value), status: 'pending' }); inserted++; } offset = Math.max(offset, value.update_id + 1); } settings.set('telegram_offset', offset); return { inserted, offset }; },
    async listPendingUpdates(limit) { return [...updates.values()].filter(row => row.status === 'pending').sort((a, b) => a.update_id - b.update_id).slice(0, limit).map(clone); },
    async setUpdateStatus(id, status, error = null) { Object.assign(updates.get(id), { status, error, ...(status === 'processed' ? { payload: {} } : {}) }); },
    async acquireLock() { if (locked) return false; locked = true; return true; }, async releaseLock() { locked = false; },
    async hasTelegramHistory() { return links.size > 0 || updates.size > 0 || [...drafts.values()].some(row => row.source === 'telegram'); },
  };
  const bucket = {
    async createSignedUploadUrl(path, options) { assert.equal(options.upsert, false); mock.signedPaths.push(path); return { data: { path, token: 'signed-test-token', signedUrl: 'https://dedicated.supabase.co/storage/v1/object/upload/sign/arios-audio/' + path + '?token=signed-test-token' }, error: null }; },
    async createSignedUrl(path, seconds) { mock.playbackSigns.push({ path, seconds }); return { data: { signedUrl: 'https://dedicated.supabase.co/storage/v1/object/sign/arios-audio/' + path + '?token=read-test-token' }, error: null }; },
    async upload(path, blob, options) { assert.equal(options.upsert, false); if (objects.has(path)) return { error: { statusCode: '409' } }; objects.set(path, { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: options.contentType }); mock.storageWrites.push(path); return { data: { path }, error: null }; },
    async info(path) { const value = objects.get(path); return value ? { data: { size: value.bytes.byteLength, contentType: value.mimeType }, error: null } : { data: null, error: { message: 'Not found' } }; },
    async download(path) { mock.downloadCount++; const value = objects.get(path); return value ? { data: new Blob([value.bytes], { type: value.mimeType }), error: null } : { data: null, error: {} }; },
    async remove(paths) { for (const path of paths) { objects.delete(path); mock.storageDeletes.push(path); } return { data: [], error: null }; },
  };
  const supabase = { storage: { from(name) { assert.equal(name, 'arios-audio'); return bucket; } } };
  const fetcher = async (input, options) => {
    const url = new URL(input); mock.fetchCalls.push({ url, options }); assert.equal(options.redirect, 'manual');
    if (url.hostname === 'api.telegram.org') {
      if (mock.telegramFailure) return new Response(JSON.stringify({ ok: false, description: TOKEN }), { status: mock.telegramFailure, headers: { 'Content-Type': 'application/json' } });
      if (url.pathname.endsWith('/getMe')) return response({ ok: true, result: { id: 123456, is_bot: true, username: 'AriosTestBot' } });
      if (url.pathname.endsWith('/getWebhookInfo')) return response({ ok: true, result: { url: '' } });
      if (url.pathname.endsWith('/getUpdates')) return response({ ok: true, result: mock.incoming });
      if (url.pathname.endsWith('/getFile')) return response({ ok: true, result: { file_path: 'voice/test.ogg', file_size: OGG.byteLength } });
      if (url.pathname.includes('/file/bot')) return new Response(OGG, { headers: { 'Content-Type': 'audio/ogg' } });
    }
    if (url.pathname.endsWith('/audio/transcriptions')) return response({ text: TRANSCRIPT });
    if (url.pathname.endsWith('/chat/completions')) {
      if (mock.extractionFailure) return response({ choices: [{ message: { content: 'invalid-json' } }] });
      const data = JSON.parse(options.body), context = JSON.parse(data.messages[1].content);
      return response({ choices: [{ message: { content: JSON.stringify({ projectId: context.authorizedProjects[0]?.id || null, date: '2026-10-20', start: '09:00', end: '17:00', breakMinutes: 30, description: 'نصب و فعال‌سازی چهار دوربین', output: 'چهار دوربین فعال شد.', warnings: [] }) } }] });
    }
    assert.fail('Unexpected mocked endpoint');
  };
  const call = async (path, payload, userId = 'manager', method = payload === undefined ? 'GET' : 'POST') => {
    const user = state.users.find(user => user.id === userId);
    const request = new Request('https://arios.test' + path, { method, headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {}, ...(method === 'POST' ? { body: JSON.stringify(payload || {}) } : {}) });
    try { const result = await handleVoice({ path, request, supabase, repo, user, fetcher }); return { status: result.status, data: await result.json() }; }
    catch (error) { return { status: error.status || 500, data: { error: error.message, code: error.code } }; }
  };
  return { repo, supabase, fetcher, call, mock, settings, drafts, links, codes, updates, objects, state: () => state };
}

test('private integration config is filtered; failed Telegram validation preserves previous secrets', async () => {
  const f = fixture();
  assert.equal((await getConfig(f.repo)).aiApiKey, KEY);
  assert.equal('aiApiKey' in safeConfig(await getConfig(f.repo)), false);
  f.mock.telegramFailure = 401;
  const before = await f.repo.getSetting('integrations');
  const failed = await f.call('/api/integrations', { aiApiKey: 'replacement-only-test-key', telegramBotToken: TOKEN });
  assert.equal(failed.status, 400); assert.equal(failed.data.code, 'TELEGRAM_TOKEN_INVALID'); assert.ok(!failed.data.error.includes(TOKEN));
  assert.deepEqual(await f.repo.getSetting('integrations'), before);
  f.mock.telegramFailure = 302;
  const redirected = await f.call('/api/integrations', { telegramBotToken: TOKEN });
  assert.equal(redirected.status, 502); assert.equal(redirected.data.code, 'TELEGRAM_REDIRECT');
  assert.deepEqual(await f.repo.getSetting('integrations'), before);
  f.mock.telegramFailure = null;
  const success = await f.call('/api/integrations', { telegramBotToken: TOKEN });
  assert.equal(success.status, 200);
  const visible = await f.call('/api/voice');
  assert.ok(!JSON.stringify(visible.data).includes(KEY)); assert.ok(!JSON.stringify(visible.data).includes(TOKEN));
});

test('signed upload is owner-scoped, bounded, private and finalized from the stored object', async () => {
  const f = fixture();
  const signed = await f.call('/api/voice/upload-url', { fileName: '../../secret.ogg', mimeType: 'audio/ogg', size: OGG.byteLength, projectId: 'p1', path: 'other-user/file.ogg' }, 'worker');
  assert.equal(signed.status, 200); assert.match(signed.data.path, /^voice\/worker\/[a-f0-9-]+\.ogg$/);
  assert.equal(signed.data.token, 'signed-test-token'); assert.equal(signed.data.uploadUrl.includes('/upload/sign/arios-audio/'), true);
  const row = f.drafts.get(signed.data.draftId);
  assert.equal(row.source_metadata.expected_size, OGG.byteLength); assert.equal(row.user_id, 'worker');
  f.objects.set(row.storage_path, { bytes: OGG, mimeType: 'audio/ogg' });
  const completed = await f.call('/api/voice/upload-complete', { id: row.id }, 'worker');
  assert.equal(completed.status, 200); assert.equal(completed.data.status, 'ready'); assert.equal(completed.data.fields.projectId, 'p1');
  assert.equal(f.objects.has(row.storage_path), true); assert.equal(f.drafts.get(row.id).transcript, TRANSCRIPT);
  assert.equal(completed.data.audio.available, true);
  for (const key of ['source_metadata', 'storage_path', 'file_id', 'claim']) assert.equal(key in completed.data, false);
  assert.equal((await f.call('/api/voice/upload-url', { fileName: 'a.ogg', mimeType: 'audio/ogg', size: 20 * 1024 * 1024 + 1 }, 'worker')).status, 413);
});

test('upload finalization verifies actual server size and ownership before provider processing', async () => {
  const f = fixture();
  const signed = await f.call('/api/voice/upload-url', { fileName: 'a.ogg', mimeType: 'audio/ogg', size: 8 }, 'worker');
  const row = f.drafts.get(signed.data.draftId);
  const forbidden = await f.call('/api/voice/upload-complete', { id: row.id }, 'worker2');
  assert.equal(forbidden.status, 403);
  f.objects.set(row.storage_path, { bytes: new Uint8Array(3), mimeType: 'audio/ogg' });
  const mismatched = await f.call('/api/voice/upload-complete', { id: row.id }, 'worker');
  assert.equal(mismatched.data.status, 'failed'); assert.match(mismatched.data.error, /حجم/); assert.equal(f.mock.fetchCalls.length, 0);
  f.objects.set(row.storage_path, { bytes: OGG, mimeType: 'application/pdf' });
  const wrongType = await f.call('/api/voice/retry', { id: row.id }, 'worker');
  assert.equal(wrongType.data.status, 'failed'); assert.match(wrongType.data.error, /صوتی/);
});

test('transcript checkpoint survives extraction failure and retry does not re-transcribe the retained original', async () => {
  const f = fixture();
  const signed = await f.call('/api/voice/upload-url', { fileName: 'a.ogg', mimeType: 'audio/ogg', size: 8, projectId: 'p1' }, 'worker');
  const row = f.drafts.get(signed.data.draftId); f.objects.set(row.storage_path, { bytes: OGG, mimeType: 'audio/ogg' });
  f.mock.extractionFailure = true;
  const failed = await f.call('/api/voice/upload-complete', { id: row.id }, 'worker');
  assert.equal(failed.data.status, 'failed'); assert.equal(failed.data.transcript, TRANSCRIPT); assert.equal(f.objects.has(row.storage_path), true);
  f.mock.extractionFailure = false;
  const ready = await f.call('/api/voice/retry', { id: row.id }, 'worker');
  assert.equal(ready.data.status, 'ready'); assert.equal(f.mock.fetchCalls.filter(call => call.url.pathname.endsWith('/audio/transcriptions')).length, 1); assert.equal(f.mock.downloadCount, 1);
});

test('Telegram linking, durable polling and draft/report submission are idempotent and scoped', async () => {
  const f = fixture();
  const code = await f.call('/api/telegram/link', { userId: 'worker' });
  assert.equal(code.status, 200); assert.equal(f.codes.size, 1);
  f.mock.incoming = [
    { update_id: 10, message: { from: { id: 444, is_bot: false }, chat: { id: 444, type: 'private' }, text: '/start ' + code.data.code } },
    { update_id: 11, message: { from: { id: 444, is_bot: false }, chat: { id: 444, type: 'private' }, voice: { file_id: 'voice-id', file_size: 8 } } },
  ];
  const synced = await syncTelegram(f);
  assert.equal(synced.received, 2); assert.equal(synced.processed, 1); assert.equal(f.codes.size, 0); assert.equal(f.links.get('444').user_id, 'worker');
  assert.equal(await f.repo.getSetting('telegram_offset'), 12); assert.equal(f.updates.get(10).status, 'processed'); assert.deepEqual(f.updates.get(10).payload, {});
  const repeat = await syncTelegram(f); assert.equal(repeat.received, 0); assert.equal(f.drafts.size, 1);
  const draft = f.drafts.get('telegram_11'); assert.equal(draft.status, 'ready');
  const fields = { ...draft.fields, projectId: 'p1', workerId: 'worker', date: '2026-10-20', start: '09:00', end: '17:00', breakMinutes: 30 };
  const spoof = await f.call('/api/voice/submit', { id: draft.id, fields: { ...fields, workerId: 'worker2' } }, 'worker'); assert.equal(spoof.status, 403);
  const originalCount = f.state().reports.length;
  const submitted = await f.call('/api/voice/submit', { id: draft.id, fields }, 'worker'); assert.equal(submitted.status, 200);
  const submittedAgain = await f.call('/api/voice/submit', { id: draft.id, fields: { ...fields, description: 'تلاش برای جایگزینی گزارش نهایی' } }, 'worker');
  assert.equal(submittedAgain.data.result.id, submitted.data.result.id); assert.equal(f.state().reports.length, originalCount + 1);
  const saved = f.state().reports.at(-1); assert.equal(saved.workerId, 'worker'); assert.equal(saved.status, 'submitted'); assert.equal(saved.laborCost, 0); assert.equal(saved.source, 'telegram');
});

test('customers cannot use voice APIs; workers cannot manage integration or synchronize other accounts', async () => {
  const f = fixture();
  assert.equal((await f.call('/api/voice', undefined, 'customer')).status, 403);
  assert.equal((await f.call('/api/integrations', { aiApiKey: 'not-authorized' }, 'worker')).status, 403);
  assert.equal((await f.call('/api/telegram/link', { userId: 'worker2' }, 'worker')).status, 403);
  assert.equal((await f.call('/api/telegram/sync', {}, 'worker')).status, 403);
  assert.equal((await f.call('/api/voice/upload-url', { fileName: 'a.ogg', mimeType: 'audio/ogg', size: 8, projectId: 'p4' }, 'worker')).status, 403);
});

test('private upload and Telegram audio expire after seven days while recent completed audio and transcripts remain', async () => {
  const f = fixture();
  await f.repo.createDraft({ id: 'old-upload', userId: 'worker', source: 'upload', storagePath: 'voice/worker/old-upload.ogg', createdAt: new Date(Date.now() - 8 * 86400000).toISOString() });
  await f.repo.createDraft({ id: 'completed-upload', userId: 'worker', source: 'upload', status: 'ready', transcript: TRANSCRIPT, storagePath: 'voice/worker/completed-upload.ogg', createdAt: new Date(Date.now() - 4 * 3600000).toISOString() });
  await f.repo.createDraft({ id: 'old-telegram', userId: 'worker', source: 'telegram', status: 'ready', transcript: TRANSCRIPT, fileId: 'old-file', storagePath: 'voice/worker/old-telegram.ogg', createdAt: new Date(Date.now() - 8 * 86400000).toISOString() });
  f.objects.set('voice/worker/old-upload.ogg', { bytes: OGG, mimeType: 'audio/ogg' }); f.objects.set('voice/worker/completed-upload.ogg', { bytes: OGG, mimeType: 'audio/ogg' });
  f.objects.set('voice/worker/old-telegram.ogg', { bytes: OGG, mimeType: 'audio/ogg' });
  await f.call('/api/voice');
  assert.equal(f.drafts.get('old-upload').status, 'failed'); assert.equal(f.drafts.get('old-upload').storage_path, null);
  assert.equal(f.drafts.get('completed-upload').transcript, TRANSCRIPT); assert.equal(f.drafts.get('completed-upload').status, 'ready'); assert.equal(f.drafts.get('completed-upload').storage_path, 'voice/worker/completed-upload.ogg');
  assert.equal(f.drafts.get('old-telegram').storage_path, null); assert.equal(f.drafts.get('old-telegram').transcript, TRANSCRIPT); assert.equal(f.objects.size, 1);
});

test('audio playback requires ownership or manager access and never leaks private file identifiers or credentials', async () => {
  const f = fixture();
  await f.repo.createDraft({ id: 'play-upload', userId: 'worker', source: 'upload', status: 'failed', storagePath: 'voice/worker/play-upload.ogg', sourceMetadata: { expected_size: OGG.byteLength, mime_type: 'audio/ogg', file_name: 'voice.ogg' } });
  f.objects.set('voice/worker/play-upload.ogg', { bytes: OGG, mimeType: 'audio/ogg' });
  for (const who of ['customer', 'worker2']) {
    const forbidden = await f.call('/api/voice/audio', { id: 'play-upload' }, who);
    assert.equal(forbidden.status, 403); assert.equal(f.mock.playbackSigns.length, 0); assert.equal(f.mock.downloadCount, 0);
  }
  for (const who of ['worker', 'manager']) {
    const played = await f.call('/api/voice/audio', { id: 'play-upload', path: 'other-user/secret.ogg' }, who);
    assert.equal(played.status, 200); assert.match(played.data.url, /\/object\/sign\/arios-audio\/voice\/worker\/play-upload\.ogg\?token=/);
    assert.equal(played.data.mimeType, 'audio/ogg'); assert.equal(played.data.fileName, 'voice.ogg');
    assert.ok(Date.parse(played.data.expiresAt) > Date.now());
    assert.equal(JSON.stringify(played.data).includes(KEY), false); assert.equal(JSON.stringify(played.data).includes(TOKEN), false);
  }
  assert.ok(f.mock.playbackSigns.every(item => item.seconds > 0 && item.seconds <= 300));
  assert.equal(f.mock.downloadCount, 0, 'signing an existing audio object must not download its bytes into the API');
  const listed = await f.call('/api/voice', undefined, 'worker');
  const view = listed.data.drafts.find(item => item.id === 'play-upload');
  assert.equal(view.audio.available, true);
  for (const secret of ['read-test-token', 'voice/worker/play-upload.ogg', TOKEN, KEY]) assert.equal(JSON.stringify(listed.data).includes(secret), false);
});

test('existing Telegram drafts cache the original once and can play without an AI configuration', async () => {
  const f = fixture();
  f.settings.set('integrations', { telegramBotToken: TOKEN });
  await f.repo.createDraft({ id: 'telegram_88', userId: 'worker', source: 'telegram', status: 'failed', fileId: 'private-telegram-file', sourceMetadata: { expected_size: OGG.byteLength } });
  const first = await f.call('/api/voice/audio', { id: 'telegram_88' }, 'worker');
  assert.equal(first.status, 200); assert.equal(f.objects.has('voice/worker/telegram_88.ogg'), true);
  assert.deepEqual(f.mock.storageWrites, ['voice/worker/telegram_88.ogg']);
  assert.equal(first.data.url.includes(TOKEN), false); assert.equal(first.data.url.includes('api.telegram.org'), false);
  const callsBefore = f.mock.fetchCalls.length;
  const second = await f.call('/api/voice/audio', { id: 'telegram_88' });
  assert.equal(second.status, 200); assert.equal(f.mock.fetchCalls.length, callsBefore);
  assert.equal(f.mock.fetchCalls.some(item => /audio\/transcriptions|chat\/completions/.test(item.url.pathname)), false);
  assert.equal(f.drafts.get('telegram_88').status, 'failed', 'playback does not change report processing status');
});

test('expired, textual, missing and corrupt audio cannot receive a playback URL', async () => {
  const f = fixture();
  await f.repo.createDraft({ id: 'expired-telegram', userId: 'worker', source: 'telegram', fileId: 'expired-file', createdAt: new Date(Date.now() - 8 * 86400000).toISOString() });
  await f.repo.createDraft({ id: 'text-only', userId: 'worker', source: 'text', transcript: TRANSCRIPT });
  await f.repo.createDraft({ id: 'bad-path', userId: 'worker', source: 'upload', storagePath: 'voice/worker2/bad-path.ogg' });
  await f.repo.createDraft({ id: 'missing-file', userId: 'worker', source: 'upload', storagePath: 'voice/worker/missing-file.ogg' });
  assert.equal((await f.call('/api/voice/audio', { id: 'expired-telegram' }, 'worker')).status, 410);
  assert.equal((await f.call('/api/voice/audio', { id: 'text-only' }, 'worker')).status, 404);
  assert.equal((await f.call('/api/voice/audio', { id: 'bad-path' }, 'worker')).status, 400);
  assert.equal((await f.call('/api/voice/audio', { id: 'missing-file' }, 'worker')).status, 404);
  assert.equal(f.mock.fetchCalls.length, 0); assert.equal(f.mock.playbackSigns.length, 0);
});

test('playback links never outlive retention and reject unexpected signing destinations', async () => {
  const f = fixture();
  await f.repo.createDraft({ id: 'nearly-expired', userId: 'worker', source: 'upload', storagePath: 'voice/worker/nearly-expired.ogg', createdAt: new Date(Date.now() - 7 * 86400000 + 120000).toISOString(), sourceMetadata: { expected_size: OGG.byteLength, mime_type: 'audio/ogg', file_name: 'voice.ogg' } });
  f.objects.set('voice/worker/nearly-expired.ogg', { bytes: OGG, mimeType: 'audio/ogg' });
  const signed = await f.call('/api/voice/audio', { id: 'nearly-expired' }, 'worker');
  assert.equal(signed.status, 200); assert.ok(f.mock.playbackSigns[0].seconds > 0 && f.mock.playbackSigns[0].seconds <= 120);
  const bucket = f.supabase.storage.from('arios-audio');
  for (const url of ['https://external.example/audio?token=private', 'https://dedicated.supabase.co/storage/v1/object/sign/arios-audio/voice/worker2/private.ogg?token=private']) {
    bucket.createSignedUrl = async () => ({ data: { signedUrl: url }, error: null });
    const invalid = await f.call('/api/voice/audio', { id: 'nearly-expired' }, 'worker');
    assert.equal(invalid.status, 503); assert.equal(invalid.data.code, 'AUDIO_URL_FAILED'); assert.equal(JSON.stringify(invalid.data).includes('private'), false);
  }
});
