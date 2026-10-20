import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../worker/index.mjs';
import { createTestD1 } from './helpers/d1.mjs';

const ORIGIN = 'https://arios.test';
const BOT_TOKEN = '123456:arios_test_token_123456789012345';
const AI_KEY = 'arios_test_ai_key_not_a_real_credential';
const TRANSCRIPT = 'در پروژه آریوس در تاریخ 2026-10-20 از ساعت 09:00 تا 17:00 کار کردم. 30 دقیقه استراحت داشتم. کابل شبکه نصب شد و ارتباط دوربین آزمایش شد.';
const owner = { id: 'chatgpt-owner', email: 'owner@example.com' };
const workerIdentity = { id: 'chatgpt-worker', email: 'worker@example.com' };
const customerIdentity = { id: 'chatgpt-customer', email: 'customer@example.com' };
const responseJSON = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

function fixture(t) {
  const db = createTestD1();
  t.after(() => db.close());
  const mock = { updates: [], calls: [], extractionFailure: false, transcriptionFailure: false, botId: 123456 };
  const bucket = {
    objects: new Map(), puts: [], gets: [], deletes: [],
    async put(key, value, options = {}) {
      const bytes = new Uint8Array(value);
      this.objects.set(key, { bytes: bytes.slice(), customMetadata: { ...options.customMetadata } });
      this.puts.push(key);
    },
    async get(key) {
      this.gets.push(key);
      const value = this.objects.get(key);
      return value ? { customMetadata: { ...value.customMetadata }, arrayBuffer: async () => value.bytes.slice().buffer } : null;
    },
    async delete(key) { this.objects.delete(key); this.deletes.push(key); },
  };
  const fetcher = async (input, options = {}) => {
    const url = new URL(String(input));
    mock.calls.push({ host: url.hostname, path: url.pathname, options });
    if (url.hostname === 'api.telegram.org') {
      if (url.pathname.endsWith('/getMe')) return responseJSON({ ok: true, result: { id: mock.botId, is_bot: true, username: 'AriosTestBot' } });
      if (url.pathname.endsWith('/getWebhookInfo')) return responseJSON({ ok: true, result: { url: '' } });
      if (url.pathname.endsWith('/getUpdates')) return responseJSON({ ok: true, result: mock.updates });
      if (url.pathname.endsWith('/getFile')) return responseJSON({ ok: true, result: { file_id: 'voice-test', file_size: 8, file_path: 'voice/test.ogg' } });
      if (url.pathname.startsWith('/file/bot')) return new Response(new Uint8Array([79, 103, 103, 83, 0, 1, 2, 3]), { headers: { 'Content-Type': 'audio/ogg' } });
    }
    if (url.hostname === 'api.avalai.ir' && url.pathname === '/v1/audio/transcriptions') {
      if (mock.transcriptionFailure) return new Response('Temporarily unavailable', { status: 503 });
      assert(options.body instanceof FormData);
      assert.equal(options.body.get('language'), 'fa');
      assert.equal(options.body.get('model'), 'whisper-1');
      assert.equal(options.body.get('file').type, 'audio/ogg');
      return responseJSON({ text: TRANSCRIPT });
    }
    if (url.hostname === 'api.avalai.ir' && url.pathname === '/v1/chat/completions') {
      if (mock.extractionFailure) return responseJSON({ choices: [{ message: { content: 'not-json' } }] });
      const body = JSON.parse(options.body);
      const message = JSON.parse(body.messages[1].content);
      const projectId = message.authorizedProjects?.[0]?.id;
      if (projectId) return responseJSON({ choices: [{ message: { content: JSON.stringify({ projectId, date: '2026-10-20', start: '09:00', end: '17:00', breakMinutes: 30, description: 'نصب کابل شبکه و آزمایش ارتباط دوربین', output: 'ارتباط دوربین برقرار شد.', warnings: [] }) } }] });
      return responseJSON({ choices: [{ message: { content: JSON.stringify({ answer: 'اتصال برق و شبکه پروژه را بررسی کنید.', needsHumanSupport: false }) } }] });
    }
    assert.fail(`Unexpected mocked upstream: ${url.hostname}${url.pathname}`);
  };
  const env = { DB: db, BUCKET: bucket, ARIOS_OWNER_EMAIL: owner.email, ARIOS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
  const handler = createHandler({ fetcher });
  const call = async (path, { identity = owner, method = 'GET', body, origin = ORIGIN } = {}) => {
    const headers = new Headers();
    if (identity) {
      headers.set('oai-authenticated-user-id', identity.id);
      headers.set('oai-authenticated-user-email', identity.email);
    }
    if (method === 'POST') {
      if (origin) headers.set('Origin', origin);
      headers.set('Content-Type', 'application/json');
    }
    const response = await handler(new Request(ORIGIN + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
    const data = await response.json();
    return { status: response.status, data };
  };
  const post = (path, body, identity = owner) => call(path, { method: 'POST', body, identity });
  const action = (action, payload, identity = owner) => post('/api/actions', { action, payload }, identity);
  return { db, bucket, env, handler, mock, call, post, action };
}

async function configuredWorkspace(f) {
  const session = await f.call('/api/session');
  assert.equal(session.status, 200);
  assert.equal(session.data.user.role, 'manager');
  const account = await f.action('account.create', { name: 'نیروی آریوس', email: workerIdentity.email, role: 'worker', projectIds: [] });
  assert.equal(account.status, 200, JSON.stringify(account.data));
  const workerId = account.data.result.id;
  const project = await f.action('project.create', { name: 'پروژه آریوس', type: 'نظارت تصویری', location: 'تهران', customerId: null, memberIds: [workerId], budget: 10000000, contractAmount: 20000000, startDate: '2026-01-01', endDate: '2026-12-31', description: 'نصب شبکه و دوربین' });
  assert.equal(project.status, 200, JSON.stringify(project.data));
  const projectId = project.data.result.id;
  const rate = await f.action('worker.rate', { id: workerId, hourlyRate: 120000, effectiveDate: '2026-01-01' });
  assert.equal(rate.status, 200);
  const configured = await f.post('/api/integrations', { aiBaseUrl: 'https://api.avalai.ir/v1', aiApiKey: AI_KEY, aiModel: 'gpt-4o-mini', transcriptionModel: 'whisper-1', telegramBotToken: BOT_TOKEN });
  assert.equal(configured.status, 200, JSON.stringify(configured.data));
  return { workerId, projectId, configured: configured.data };
}

test('hosted owner bootstraps an empty durable workspace and identities are authorized', async t => {
  const f = fixture(t);
  const anonymous = await f.call('/api/state', { identity: null });
  assert.equal(anonymous.status, 401);
  const unknownFirst = await f.call('/api/state', { identity: { id: 'unknown', email: 'stranger@example.com' } });
  assert.equal(unknownFirst.status, 403);
  assert.equal(unknownFirst.data.code, 'OWNER_REQUIRED');
  assert.equal(f.db.sqlite.prepare('SELECT count(*) AS n FROM arios_state').get().n, 0);
  const session = await f.call('/api/session');
  assert.equal(session.status, 200);
  assert.equal(session.data.authMode, 'chatgpt');
  assert.equal(session.data.demo, false);
  assert.equal(session.data.capabilities.hosted, true);
  assert.equal(session.data.user.email, owner.email);
  const state = await f.call('/api/state');
  assert.equal(state.data.users.length, 1);
  for (const key of ['projects', 'reports', 'materials', 'invoices', 'inventory']) assert.deepEqual(state.data[key], []);
  const reloaded = await createHandler()(new Request(ORIGIN + '/api/state', { headers: { 'oai-authenticated-user-id': owner.id, 'oai-authenticated-user-email': owner.email } }), f.env);
  assert.equal(reloaded.status, 200);
  assert.equal((await reloaded.json()).user.id, 'manager');
  const stranger = await f.call('/api/session', { identity: { id: 'stranger', email: 'stranger@example.com' } });
  assert.equal(stranger.status, 403);
  assert.equal(stranger.data.code, 'NOT_A_MEMBER');
  const spoofedIdentity = await f.call('/api/state', { identity: { id: 'another-identity', email: owner.email } });
  assert.equal(spoofedIdentity.status, 403);
  assert.equal(spoofedIdentity.data.code, 'IDENTITY_MISMATCH');
  const crossOrigin = await f.call('/api/actions', { method: 'POST', origin: 'https://unrelated.test', body: { action: 'worker.create', payload: {} } });
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.data.code, 'ORIGIN_DENIED');
});

test('Telegram voice becomes one editable draft and one reviewed report across duplicate delivery and submission', async t => {
  const f = fixture(t);
  const { workerId, projectId, configured } = await configuredWorkspace(f);
  assert.equal(configured.integration.aiConfigured, true);
  assert.equal(configured.telegram.botUsername, 'AriosTestBot');
  assert(!JSON.stringify(configured).includes(AI_KEY));
  assert(!JSON.stringify(configured).includes(BOT_TOKEN));
  const encrypted = f.db.sqlite.prepare('SELECT value FROM arios_settings WHERE key=?').get('integrations').value;
  assert.match(encrypted, /^v1:/);
  assert(!encrypted.includes(AI_KEY));
  assert(!encrypted.includes(BOT_TOKEN));
  const link = await f.post('/api/telegram/link', { userId: workerId });
  assert.equal(link.status, 200);
  assert.match(link.data.code, /^[a-f0-9]{32}$/);
  f.mock.updates = [
    { update_id: 100, message: { message_id: 1, from: { id: 901, is_bot: false }, chat: { id: 901, type: 'private' }, text: '/start ' + link.data.code } },
    { update_id: 101, message: { message_id: 2, from: { id: 901, is_bot: false }, chat: { id: 901, type: 'private' }, voice: { file_id: 'voice-test', file_size: 8, mime_type: 'audio/ogg', duration: 20 } } },
  ];
  const synced = await f.post('/api/telegram/sync', {});
  assert.equal(synced.status, 200, JSON.stringify(synced.data));
  assert.equal(synced.data.received, 2);
  assert.equal(synced.data.processed, 1);
  assert.equal(synced.data.failed, 0);
  assert.equal(f.db.sqlite.prepare('SELECT count(*) AS n FROM arios_link_codes').get().n, 0);
  assert.equal(f.db.sqlite.prepare('SELECT value FROM arios_settings WHERE key=?').get('telegram_offset').value, '102');
  const voice = await f.call('/api/voice');
  assert.equal(voice.status, 200);
  assert.equal(voice.data.drafts.length, 1);
  const draft = voice.data.drafts[0];
  assert.equal(draft.userId, workerId);
  assert.equal(draft.source, 'telegram');
  assert.equal(draft.status, 'ready');
  assert.equal(draft.transcript, TRANSCRIPT);
  assert.equal(draft.fields.projectId, projectId);
  assert.equal(draft.fields.breakMinutes, 30);
  assert.equal(voice.data.telegram.links[0].userId, workerId);
  assert(!JSON.stringify(voice.data).includes(BOT_TOKEN));
  assert(!JSON.stringify(voice.data).includes(AI_KEY));
  const duplicateDelivery = await f.post('/api/telegram/sync', {});
  assert.equal(duplicateDelivery.status, 200);
  assert.equal(duplicateDelivery.data.processed, 0);
  assert.equal(f.db.sqlite.prepare('SELECT count(*) AS n FROM arios_drafts').get().n, 1);
  assert.equal(f.mock.calls.filter(call => call.path.endsWith('/audio/transcriptions')).length, 1);
  const fields = { ...draft.fields, workerId, description: 'شرح اصلاح‌شده پس از بازبینی ویس' };
  const submitted = await f.post('/api/voice/submit', { id: draft.id, fields });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
  assert.equal(submitted.data.state.reports.length, 1);
  const report = submitted.data.state.reports[0];
  assert.equal(report.workerId, workerId);
  assert.equal(report.status, 'submitted');
  assert.equal(report.description, fields.description);
  assert.equal(report.minutes, 450);
  assert.equal(report.laborCost, 0);
  const duplicateSubmission = await f.post('/api/voice/submit', { id: draft.id, fields });
  assert.equal(duplicateSubmission.status, 200);
  assert.equal(duplicateSubmission.data.result.id, report.id);
  assert.equal(duplicateSubmission.data.state.reports.length, 1);
  const changedRetry = await f.post('/api/voice/submit', { id: draft.id, fields: { ...fields, projectId: 'unrelated-project', start: '00:00', description: 'این متن نباید جایگزین گزارش ثبت‌شده شود.' } });
  assert.equal(changedRetry.status, 200);
  assert.equal(changedRetry.data.state.reports[0].description, fields.description);
  const missingFieldsRetry = await f.post('/api/voice/submit', { id: draft.id });
  assert.equal(missingFieldsRetry.status, 200);
  assert.equal(missingFieldsRetry.data.result.id, report.id);
  assert.equal(missingFieldsRetry.data.state.reports.length, 1);
  const canonical = (await f.call('/api/voice')).data.drafts[0].fields;
  assert.equal(canonical.projectId, projectId);
  assert.equal(canonical.start, fields.start);
  assert.equal(canonical.description, fields.description);
  const reviewed = await f.action('report.review', { id: report.id, status: 'approved', reviewNote: 'کار بررسی و تأیید شد.' });
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.data.state.reports[0].laborCost, 900000);
  const submittedDraft = (await f.call('/api/voice')).data.drafts[0];
  assert.equal(submittedDraft.status, 'submitted');
  assert.equal(submittedDraft.reportId, report.id);
  assert(!f.mock.calls.some(call => call.path.endsWith('/sendMessage')));
});

test('worker drafts remain scoped and customer voice access is denied', async t => {
  const f = fixture(t);
  const { workerId, projectId } = await configuredWorkspace(f);
  const customer = await f.action('account.create', { name: 'مشتری آریوس', email: customerIdentity.email, role: 'customer', projectIds: [projectId] });
  assert.equal(customer.status, 200);
  const workerState = await f.call('/api/state', { identity: workerIdentity });
  assert.equal(workerState.status, 200);
  assert.equal(workerState.data.user.id, workerId);
  const managerDraft = await f.post('/api/voice/text', { transcript: TRANSCRIPT, projectId });
  assert.equal(managerDraft.status, 200);
  assert.equal(managerDraft.data.status, 'ready');
  const workerDraft = await f.post('/api/voice/text', { transcript: TRANSCRIPT, projectId }, workerIdentity);
  assert.equal(workerDraft.status, 200);
  assert.equal(workerDraft.data.userId, workerId);
  const scoped = await f.call('/api/voice', { identity: workerIdentity });
  assert.equal(scoped.status, 200);
  assert.deepEqual(scoped.data.drafts.map(draft => draft.id), [workerDraft.data.id]);
  assert.equal('links' in scoped.data.telegram, false);
  const otherDraftRetry = await f.post('/api/voice/retry', { id: managerDraft.data.id }, workerIdentity);
  assert.equal(otherDraftRetry.status, 403);
  const otherDraftSubmit = await f.post('/api/voice/submit', { id: managerDraft.data.id, fields: workerDraft.data.fields }, workerIdentity);
  assert.equal(otherDraftSubmit.status, 403);
  const escalateSync = await f.post('/api/telegram/sync', {}, workerIdentity);
  assert.equal(escalateSync.status, 403);
  const overwriteSecrets = await f.post('/api/integrations', { aiApiKey: 'unauthorized' }, workerIdentity);
  assert.equal(overwriteSecrets.status, 403);
  for (const path of ['/api/voice', '/api/voice/text', '/api/telegram/link']) {
    const result = path === '/api/voice' ? await f.call(path, { identity: customerIdentity }) : await f.post(path, { transcript: TRANSCRIPT }, customerIdentity);
    assert.equal(result.status, 403, path);
  }
});

test('failed extraction preserves Telegram transcript for retry without a second transcription', async t => {
  const f = fixture(t);
  const { workerId } = await configuredWorkspace(f);
  const link = await f.post('/api/telegram/link', { userId: workerId });
  f.mock.updates = [
    { update_id: 200, message: { from: { id: 902, is_bot: false }, chat: { id: 902, type: 'private' }, text: '/start ' + link.data.code } },
    { update_id: 201, message: { from: { id: 902, is_bot: false }, chat: { id: 902, type: 'private' }, voice: { file_id: 'voice-test', file_size: 8 } } },
  ];
  f.mock.extractionFailure = true;
  const sync = await f.post('/api/telegram/sync', {});
  assert.equal(sync.status, 200);
  assert.equal(sync.data.failed, 1);
  const failed = (await f.call('/api/voice')).data.drafts[0];
  assert.equal(failed.status, 'failed');
  assert.equal(failed.transcript, TRANSCRIPT);
  assert(failed.error);
  f.mock.extractionFailure = false;
  const retried = await f.post('/api/voice/retry', { id: failed.id });
  assert.equal(retried.status, 200);
  assert.equal(retried.data.status, 'ready');
  assert.equal(f.mock.calls.filter(call => call.path.endsWith('/audio/transcriptions')).length, 1);
});

async function uploadVoice(f, projectId) {
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array([79, 103, 103, 83, 4, 5, 6, 7])], { type: 'audio/ogg' }), 'work-report.ogg');
  form.set('projectId', projectId);
  const request = new Request(ORIGIN + '/api/voice/upload', { method: 'POST', headers: { Origin: ORIGIN, 'oai-authenticated-user-id': owner.id, 'oai-authenticated-user-email': owner.email }, body: form });
  assert.match(request.headers.get('content-type'), /^multipart\/form-data; boundary=/);
  const response = await f.handler(request, f.env);
  return { status: response.status, data: await response.json() };
}

test('multipart uploads retain private audio for transcription retry and delete it after transcript recovery', async t => {
  const f = fixture(t);
  const { projectId } = await configuredWorkspace(f);
  f.mock.transcriptionFailure = true;
  const uploaded = await uploadVoice(f, projectId);
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.data));
  assert.equal(uploaded.data.source, 'upload');
  assert.equal(uploaded.data.status, 'failed');
  assert.equal(uploaded.data.transcript, '');
  const key = 'voice/' + uploaded.data.id;
  assert.equal(f.bucket.objects.size, 1);
  assert.equal(f.bucket.objects.get(key).customMetadata.mimeType, 'audio/ogg');
  assert.equal(f.bucket.objects.get(key).customMetadata.fileName, 'work-report.ogg');
  assert.equal(f.bucket.objects.get(key).bytes.length, 8);
  assert(!JSON.stringify(uploaded.data).includes(key));
  f.mock.transcriptionFailure = false;
  const retried = await f.post('/api/voice/retry', { id: uploaded.data.id });
  assert.equal(retried.status, 200);
  assert.equal(retried.data.status, 'ready');
  assert.equal(retried.data.transcript, TRANSCRIPT);
  assert.equal(retried.data.fields.projectId, projectId);
  assert(f.bucket.gets.includes(key));
  assert(f.bucket.deletes.includes(key));
  assert.equal(f.bucket.objects.size, 0);
  const repeated = await f.post('/api/voice/retry', { id: uploaded.data.id });
  assert.equal(repeated.status, 200);
  assert.equal(f.mock.calls.filter(call => call.path.endsWith('/audio/transcriptions')).length, 2);
});

test('expired untranscribed upload audio is removed during bounded retention cleanup', async t => {
  const f = fixture(t);
  const { projectId } = await configuredWorkspace(f);
  f.mock.transcriptionFailure = true;
  const first = await uploadVoice(f, projectId);
  assert.equal(first.data.status, 'failed');
  const key = 'voice/' + first.data.id;
  f.db.sqlite.prepare('UPDATE arios_drafts SET created_at=? WHERE id=?').run(new Date(Date.now() - 8 * 86400000).toISOString(), first.data.id);
  const second = await uploadVoice(f, projectId);
  assert.equal(second.status, 200);
  assert(!f.bucket.objects.has(key));
  assert(f.bucket.deletes.includes(key));
  const expired = f.db.sqlite.prepare('SELECT status,error FROM arios_drafts WHERE id=?').get(first.data.id);
  assert.equal(expired.status, 'failed');
  assert.match(expired.error, /مهلت نگه‌داری/);
  assert.equal(f.bucket.objects.size, 1);
});

test('provider changes require a new dedicated key and Telegram history permits only same-bot token rotation', async t => {
  const f = fixture(t);
  const { workerId } = await configuredWorkspace(f);
  const providerChange = await f.post('/api/integrations', { aiBaseUrl: 'https://api.openai.com/v1' });
  assert.equal(providerChange.status, 400);
  const blankKeyChange = await f.post('/api/integrations', { aiBaseUrl: 'https://api.openai.com/v1', aiApiKey: '   ' });
  assert.equal(blankKeyChange.status, 400);
  assert.equal((await f.call('/api/voice')).data.integration.aiBaseUrl, 'https://api.avalai.ir/v1');
  const link = await f.post('/api/telegram/link', { userId: workerId });
  f.mock.updates = [{ update_id: 300, message: { from: { id: 903, is_bot: false }, chat: { id: 903, type: 'private' }, text: '/start ' + link.data.code } }];
  assert.equal((await f.post('/api/telegram/sync', {})).status, 200);
  const rotatedToken = '123456:arios_rotated_token_123456789012345';
  const rotation = await f.post('/api/integrations', { telegramBotToken: rotatedToken });
  assert.equal(rotation.status, 200);
  assert(!JSON.stringify(rotation.data).includes(rotatedToken));
  f.mock.botId = 654321;
  const replaced = await f.post('/api/integrations', { telegramBotToken: '654321:arios_other_bot_token_123456789012345' });
  assert.equal(replaced.status, 409);
  assert.equal(replaced.data.code, 'BOT_HAS_HISTORY');
  const links = f.db.sqlite.prepare('SELECT telegram_user_id,user_id FROM arios_telegram_links').all();
  assert.equal(links.length, 1);
  assert.equal(links[0].user_id, workerId);
  assert.equal(f.db.sqlite.prepare('SELECT value FROM arios_settings WHERE key=?').get('telegram_offset').value, '301');
});

test('manager assistant receives operational context without finance or worker rate fields', async t => {
  const f = fixture(t);
  const { workerId, projectId } = await configuredWorkspace(f);
  const report = await f.action('report.create', { workerId, projectId, date: '2026-10-20', start: '09:00', end: '17:00', breakMinutes: 30, description: 'نصب تجهیزات شبکه', output: 'تست انجام شد.' });
  assert.equal(report.status, 200);
  assert.equal((await f.action('report.review', { id: report.data.result.id, status: 'approved' })).status, 200);
  assert.equal((await f.action('invoice.create', { projectId, title: 'صورت‌حساب محرمانه', amount: 7000000, dueDate: '2026-10-25' })).status, 200);
  const assistant = await f.post('/api/assistant', { projectId, message: 'برای بررسی قطع ارتباط دوربین چه کنم؟' });
  assert.equal(assistant.status, 200, JSON.stringify(assistant.data));
  const call = f.mock.calls.filter(call => call.path.endsWith('/chat/completions')).at(-1);
  const providerBody = JSON.parse(call.options.body);
  const context = JSON.parse(providerBody.messages[1].content).context;
  assert.deepEqual(Object.keys(context).sort(), ['project', 'reports', 'tickets']);
  assert.equal(context.project.id, projectId);
  assert.equal(context.reports.length, 1);
  assert.deepEqual(Object.keys(context.reports[0]).sort(), ['date', 'description', 'output', 'status']);
  const encoded = JSON.stringify(context);
  for (const forbidden of ['budget', 'contractAmount', 'laborCost', 'hourlyRate', 'rateHistory', 'unitPrice', 'invoices', 'receipts', 'password', 'aiApiKey', 'telegramBotToken']) assert(!encoded.includes('"' + forbidden + '"'), forbidden);
  assert(!encoded.includes('7000000'));
  assert(!encoded.includes('120000'));
  assert(!encoded.includes('900000'));
});

test('private unattended sync accepts only explicitly enabled service requests without browser origin', async t => {
  const f = fixture(t);
  await f.call('/api/session');
  const disabled = await f.call('/api/telegram/sync', { method: 'POST', identity: null, origin: null, body: {} });
  assert.equal(disabled.status, 401);
  f.env.ARIOS_PRIVATE_SERVICE_SYNC = '1';
  const browser = await f.call('/api/telegram/sync', { method: 'POST', identity: null, origin: ORIGIN, body: {} });
  assert.equal(browser.status, 403);
  const noBot = await f.call('/api/telegram/sync', { method: 'POST', identity: null, origin: null, body: {} });
  assert.equal(noBot.status, 200);
  assert.deepEqual(noBot.data, { received: 0, processed: 0, failed: 0, configured: false });
  assert.equal(f.mock.calls.length, 0);
  await configuredWorkspace(f);
  const service = await f.call('/api/telegram/sync', { method: 'POST', identity: null, origin: null, body: {} });
  assert.equal(service.status, 200, JSON.stringify(service.data));
  assert.equal(service.data.received, 0);
  assert.equal(service.data.processed, 0);
  assert.equal(service.data.failed, 0);
  assert(f.mock.calls.some(call => call.path.endsWith('/getUpdates')));
});
