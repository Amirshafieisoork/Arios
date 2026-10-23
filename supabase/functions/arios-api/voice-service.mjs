import { applyAction, publicState, projectAccess, DomainError } from './domain.mjs';
import { transcribeAudio, extractReport, fetchTelegramUpdates, downloadTelegramVoice, MAX_AUDIO_BYTES } from './voice-core.mjs';

const BUCKET = 'arios-audio';
const AUDIO_RETENTION_MS = 7 * 86400000;
const PLAYBACK_URL_SECONDS = 300;
const now = () => new Date().toISOString();
const fail = (message, status = 400, code = 'INVALID_INPUT') => { throw new DomainError(message, status, code); };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, label, max = 4000) => { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(`${label} معتبر نیست.`); return value.trim(); };
const manager = user => { if (user?.role !== 'manager') fail('این عملیات فقط برای مدیر مجاز است.', 403, 'FORBIDDEN'); };
const canVoice = user => { if (!user || !['manager', 'worker'].includes(user.role)) fail('دسترسی گزارش صوتی مجاز نیست.', 403, 'FORBIDDEN'); };
const tehranDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))).map(value => value.toString(16).padStart(2, '0')).join('');
const parseObject = value => { if (object(value)) return value; try { const parsed = JSON.parse(value || '{}'); return object(parsed) ? parsed : {}; } catch { return {}; } };
const audioDeadline = row => Date.parse(row.created_at) + AUDIO_RETENTION_MS;
const audioView = row => {
  const deadline = audioDeadline(row), metadata = parseObject(row.source_metadata);
  const sourceExists = row.source === 'telegram' ? Boolean(row.file_id || row.storage_path) : row.source === 'upload' && Boolean(row.storage_path);
  return { available: Boolean(sourceExists && Number.isFinite(deadline) && deadline > Date.now()), expiresAt: Number.isFinite(deadline) && row.source !== 'text' ? new Date(deadline).toISOString() : null, mimeType: sourceExists ? metadata.mime_type || (row.source === 'telegram' ? 'audio/ogg' : null) : null };
};
const draftView = row => ({ id: row.id, userId: row.user_id, source: row.source, status: row.status, transcript: row.transcript || '', fields: parseObject(row.fields), error: row.error || null, audio: audioView(row), reportId: row.report_id || null, createdAt: row.created_at });

async function bytesFromStream(stream, limit) {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel().catch(() => {}); fail('حجم درخواست یا پاسخ بیش از حد مجاز است.', 413, 'BODY_TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let position = 0;
  for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength; }
  return bytes;
}
async function readJSON(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) fail('درخواست باید JSON باشد.', 415, 'UNSUPPORTED_MEDIA');
  const bytes = await bytesFromStream(request.body, 65536);
  try { const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); if (!object(value)) throw Error(); return value; }
  catch { fail('JSON معتبر نیست.', 400, 'INVALID_JSON'); }
}
async function rate(repo, key, limit, windowMs = 60000) {
  const result = await repo.rateLimit(key, limit, windowMs);
  if (!result?.allowed) fail('تعداد درخواست‌ها زیاد است؛ کمی بعد تلاش کنید.', 429, 'RATE_LIMITED');
}

/** Integration credentials live only in service-accessible database settings. */
export async function getConfig(repo, env = {}) {
  const saved = parseObject(await repo.getSetting('integrations'));
  const aiBaseUrl = env.ARIOS_AI_BASE_URL || saved.aiBaseUrl || 'https://api.avalai.ir/v1';
  const groq = aiBaseUrl === 'https://api.groq.com/openai/v1';
  return {
    aiBaseUrl,
    aiApiKey: env.ARIOS_AI_API_KEY || saved.aiApiKey || '',
    aiModel: env.ARIOS_AI_MODEL || saved.aiModel || (groq ? 'openai/gpt-oss-20b' : ''),
    transcriptionModel: env.ARIOS_TRANSCRIPTION_MODEL || saved.transcriptionModel || (groq ? 'whisper-large-v3-turbo' : 'whisper-1'),
    telegramBotToken: env.ARIOS_TELEGRAM_BOT_TOKEN || saved.telegramBotToken || '',
    botUsername: saved.botUsername || '', botId: saved.botId || '',
  };
}
export const safeConfig = config => ({ aiConfigured: Boolean(config.aiApiKey && config.aiModel), telegramConfigured: Boolean(config.telegramBotToken), aiBaseUrl: config.aiBaseUrl, aiModel: config.aiModel, transcriptionModel: config.transcriptionModel });
export const capabilities = config => ({ hosted: true, supabaseAuth: true, ai: Boolean(config.aiApiKey && config.aiModel), voice: Boolean(config.aiApiKey && config.aiModel), telegram: Boolean(config.telegramBotToken), payments: false });

async function telegramIdentity(config, method, fetcher) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetcher(`https://api.telegram.org/bot${config.telegramBotToken}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', redirect: 'manual', signal: controller.signal });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel().catch(() => {}); fail('پاسخ تلگرام به نشانی دیگری هدایت شد؛ دوباره تلاش کنید.', 502, 'TELEGRAM_REDIRECT'); }
    if ([401, 404].includes(response.status)) { await response.body?.cancel().catch(() => {}); fail('توکن بات تلگرام معتبر نیست؛ توکن کامل BotFather را بررسی کنید.', 400, 'TELEGRAM_TOKEN_INVALID'); }
    if (response.status === 429) { await response.body?.cancel().catch(() => {}); fail('تلگرام درخواست‌های زیادی دریافت کرده؛ کمی بعد تلاش کنید.', 429, 'TELEGRAM_RATE_LIMITED'); }
    const bytes = await bytesFromStream(response.body, 32768);
    let value;
    try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { fail('پاسخ تلگرام معتبر نیست.', 502, 'TELEGRAM_INVALID_RESPONSE'); }
    if (!response.ok || value?.ok !== true) fail('بررسی اتصال تلگرام ناموفق بود؛ دوباره تلاش کنید.', 502, 'TELEGRAM_API_ERROR');
    return value.result;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') fail('زمان پاسخ تلگرام تمام شد؛ دوباره تلاش کنید.', 504, 'TELEGRAM_TIMEOUT');
    fail('ارتباط با تلگرام برقرار نشد؛ دوباره تلاش کنید.', 502, 'TELEGRAM_UNAVAILABLE');
  } finally { clearTimeout(timer); controller.abort(); }
}

async function draftFor(repo, id, user) {
  const row = await repo.getDraft(text(id, 'شناسه پیش‌نویس', 120));
  if (!row) fail('پیش‌نویس یافت نشد.', 404, 'NOT_FOUND');
  if (user.role !== 'manager' && row.user_id !== user.id) fail('به این پیش‌نویس دسترسی ندارید.', 403, 'FORBIDDEN');
  return row;
}

function uploadMetadata(payload) {
  const fileName = text(payload.fileName, 'نام فایل', 200).split(/[\\/]/).at(-1);
  const extension = fileName.split('.').at(-1).toLowerCase();
  const types = { ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'video/mp4', wav: 'audio/wav', webm: 'audio/webm', mpeg: 'audio/mpeg', flac: 'audio/flac' };
  if (!types[extension]) fail('فرمت فایل صوتی پشتیبانی نمی‌شود.', 415, 'UNSUPPORTED_AUDIO');
  const suppliedType = typeof payload.mimeType === 'string' ? payload.mimeType.split(';')[0].trim().toLowerCase() : '';
  const allowed = new Set(['audio/ogg', 'application/ogg', 'audio/opus', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/x-wav', 'audio/webm', 'audio/flac', 'audio/x-flac', 'video/mp4', 'video/webm', 'application/octet-stream', '']);
  if (!allowed.has(suppliedType)) fail('نوع فایل صوتی پشتیبانی نمی‌شود.', 415, 'UNSUPPORTED_AUDIO');
  if (!Number.isSafeInteger(payload.size) || payload.size < 1 || payload.size > MAX_AUDIO_BYTES) fail('یک فایل صوتی تا ۲۰ مگابایت انتخاب کنید.', 413, 'AUDIO_TOO_LARGE');
  return { file_name: fileName, mime_type: types[extension], expected_size: payload.size, extension, upload_expires_at: new Date(Date.now() + 2 * 3600000).toISOString() };
}

function audioStoragePath(row) {
  // Never accept a caller-supplied path. Every object belongs to one persisted draft and owner.
  if (![row.user_id, row.id].every(value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value))) fail('فایل این پیش‌نویس معتبر نیست.', 400, 'INVALID_AUDIO_PATH');
  const prefix = `voice/${row.user_id}/${row.id}.`;
  if (typeof row.storage_path !== 'string' || !row.storage_path.startsWith(prefix) || !/^(?:ogg|oga|opus|mp3|m4a|mp4|wav|webm|mpeg|flac)$/.test(row.storage_path.slice(prefix.length))) fail('فایل این پیش‌نویس معتبر نیست؛ دوباره بارگذاری کنید.', 400, 'UPLOAD_REQUIRED');
  return row.storage_path;
}

async function audioInfo(supabase, row) {
  const metadata = parseObject(row.source_metadata);
  const path = audioStoragePath(row);
  const bucket = supabase.storage.from(BUCKET);
  const { data: info, error: infoError } = await bucket.info(path);
  if (infoError || !info) fail('فایل صوتی در دسترس نیست؛ اگر بارگذاری کامل شده، فایل را دوباره انتخاب کنید.', 404, 'AUDIO_NOT_AVAILABLE');
  const actualSize = Number(info.size ?? info.metadata?.size);
  if (!Number.isSafeInteger(actualSize) || actualSize < 1 || actualSize > MAX_AUDIO_BYTES || actualSize !== metadata.expected_size) fail('حجم فایل بارگذاری‌شده با درخواست اولیه یکسان نیست.', 413, 'UPLOAD_SIZE_MISMATCH');
  const observedType = String(info.contentType || info.mimetype || info.metadata?.mimetype || '').split(';')[0].toLowerCase();
  if (observedType && !/^(?:audio\/(?:ogg|opus|mpeg|mp3|mp4|x-m4a|wav|x-wav|webm|flac|x-flac)|video\/(?:mp4|webm)|application\/(?:ogg|octet-stream))$/.test(observedType)) fail('نوع فایل بارگذاری‌شده صوتی نیست.', 415, 'UNSUPPORTED_AUDIO');
  return { bucket, actualSize, path, metadata };
}

async function storedAudio(supabase, row) {
  const { bucket, actualSize, path, metadata } = await audioInfo(supabase, row);
  const { data: blob, error } = await bucket.download(path);
  if (error || !blob || blob.size !== actualSize || blob.size > MAX_AUDIO_BYTES) fail('دریافت فایل صوتی کامل نشد؛ دوباره تلاش کنید.', 502, 'UPLOAD_DOWNLOAD_FAILED');
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: metadata.mime_type, fileName: metadata.file_name };
}

function retainedAudio(row) {
  if (row.source === 'text') fail('این پیش‌نویس از متن ساخته شده و فایل صوتی ندارد.', 404, 'AUDIO_NOT_AVAILABLE');
  if (!Number.isFinite(audioDeadline(row)) || audioDeadline(row) <= Date.now()) fail('مهلت هفت‌روزهٔ نگه‌داری صوت پایان یافته است؛ متن و گزارش همچنان در دسترس‌اند.', 410, 'AUDIO_EXPIRED');
}

async function cacheTelegramAudio({ repo, supabase, row, config, fetcher, claim }) {
  retainedAudio(row);
  if (row.storage_path) return { row, audio: await storedAudio(supabase, row) };
  if (!config.telegramBotToken || !row.file_id) fail('فایل تلگرام در دسترس نیست؛ اتصال بات را بررسی کنید.', 404, 'AUDIO_NOT_AVAILABLE');
  const metadata = parseObject(row.source_metadata);
  const audio = await downloadTelegramVoice({ token: config.telegramBotToken, fileId: row.file_id, fileSize: metadata.expected_size, fetcher });
  if (!(audio.bytes instanceof Uint8Array) || audio.bytes.byteLength < 1 || audio.bytes.byteLength > MAX_AUDIO_BYTES) fail('حجم صوت تلگرام معتبر نیست.', 413, 'AUDIO_TOO_LARGE');
  const extension = audio.fileName?.split('.').at(-1)?.toLowerCase();
  const path = `voice/${row.user_id}/${row.id}.${extension}`;
  audioStoragePath({ ...row, storage_path: path });
  const { error } = await supabase.storage.from(BUCKET).upload(path, new Blob([audio.bytes], { type: audio.mimeType }), { contentType: audio.mimeType, cacheControl: '300', upsert: false });
  // Concurrent readers may have cached this same immutable Telegram file first.
  if (error && !['409', 'Duplicate', 'ResourceAlreadyExists'].includes(String(error.statusCode || error.code))) fail('ذخیرهٔ خصوصی صوت انجام نشد؛ دوباره تلاش کنید.', 503, 'AUDIO_CACHE_FAILED');
  const updated = await repo.updateDraft(row.id, { storage_path: path, source_metadata: { ...metadata, expected_size: audio.bytes.byteLength, mime_type: audio.mimeType, file_name: audio.fileName, audio_cached_at: now() } }, claim === undefined ? {} : { claim });
  if (!updated) fail('اطلاعات ویس هم‌زمان تغییر کرد؛ دوباره تلاش کنید.', 409, 'DRAFT_CONFLICT');
  await audioInfo(supabase, updated);
  return { row: updated, audio };
}

async function cleanupAudio(repo, supabase) {
  if (!repo.expiredAudioDrafts) return;
  const expired = await repo.expiredAudioDrafts(new Date(Date.now() - AUDIO_RETENTION_MS).toISOString(), 40);
  for (const row of expired) {
    if (row.storage_path) {
      let path; try { path = audioStoragePath(row); } catch { continue; }
      const removed = await supabase.storage.from(BUCKET).remove([path]);
      if (removed.error) continue;
    }
    await repo.updateDraft(row.id, { storage_path: null, source_metadata: { ...parseObject(row.source_metadata), audio_expired_at: now() }, ...(!row.transcript ? { status: 'failed', error: 'مهلت نگه‌داری فایل گذشت؛ فایل را دوباره بارگذاری کنید.' } : {}) });
  }
}

export async function processDraft({ repo, supabase, id, fetcher = fetch, env = {} }) {
  let row = await repo.getDraft(id);
  if (!row || ['ready', 'submitted'].includes(row.status)) return row ? draftView(row) : null;
  const claim = crypto.randomUUID();
  row = await repo.claimDraft(id, claim, 300000);
  if (!row) return draftView(await repo.getDraft(id));
  // Leave room below the Edge runtime's wall-clock limit for checkpoint/error persistence.
  // A resumed job uses its saved transcript rather than spending another transcription call.
  const budget = new AbortController(), listeners = [];
  const budgetTimer = setTimeout(() => budget.abort(), 105000);
  const boundedFetcher = (url, options = {}) => {
    const controller = new AbortController();
    for (const signal of [options.signal, budget.signal].filter(Boolean)) {
      const abort = () => controller.abort();
      if (signal.aborted) controller.abort();
      else { signal.addEventListener('abort', abort, { once: true }); listeners.push(() => signal.removeEventListener('abort', abort)); }
    }
    return fetcher(url, { ...options, signal: controller.signal });
  };
  try {
    const config = await getConfig(repo, env);
    if (!config.aiApiKey || !config.aiModel) fail('اتصال اختصاصی هوش مصنوعی آریوس را در تنظیمات گزارش صوتی کامل کنید.', 503, 'AI_NOT_CONFIGURED');
    const { state } = await repo.loadState();
    const user = state.users.find(user => user.id === row.user_id);
    canVoice(user);
    const snapshot = publicState(state, user.id);
    const projects = snapshot.projects.filter(project => user.role === 'manager' || project.memberIds.includes(user.id)).map(({ id, name }) => ({ id, name }));
    let transcript = row.transcript || '';
    if (!transcript) {
      let audio;
      if (row.source === 'telegram') {
        const cached = await cacheTelegramAudio({ repo, supabase, row, config, fetcher: boundedFetcher, claim });
        row = cached.row; audio = cached.audio;
      } else { retainedAudio(row); audio = await storedAudio(supabase, row); }
      transcript = await transcribeAudio({ ...audio, config, fetcher: boundedFetcher });
      const stored = await repo.updateDraft(id, { transcript }, { claim });
      if (!stored) return draftView(await repo.getDraft(id));
      row = stored;
      // Keep the private original for playback until the seven-day retention deadline.
      // Retried extraction still uses the durable transcript rather than transcribing again.
    }
    const previous = parseObject(row.fields);
    const scopedProjects = previous.projectId ? projects.filter(project => project.id === previous.projectId) : projects;
    if (previous.projectId && !scopedProjects.length) fail('پروژه انتخابی دیگر در دسترس فرستنده ویس نیست.', 403, 'FORBIDDEN');
    const fields = await extractReport({ transcript, projects: scopedProjects, referenceDate: tehranDate(), config, fetcher: boundedFetcher });
    if (previous.projectId && scopedProjects.length) fields.projectId = previous.projectId;
    await repo.updateDraft(id, { status: 'ready', fields, error: null, claim: null, claim_until: 0 }, { claim });
  } catch (error) {
    const safeMessage = Number.isInteger(error?.status) && error?.code ? error.message : 'پردازش صوت انجام نشد؛ اتصال سرویس را بررسی و دوباره تلاش کنید.';
    await repo.updateDraft(id, { status: 'failed', error: safeMessage, claim: null, claim_until: 0 }, { claim });
  } finally { clearTimeout(budgetTimer); budget.abort(); for (const remove of listeners) remove(); }
  const saved = await repo.getDraft(id);
  return saved ? draftView(saved) : null;
}

async function consumeUpdate(repo, update) {
  const message = update?.message;
  if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0 || !message || message.chat?.type !== 'private' || !Number.isSafeInteger(message.from?.id) || !Number.isSafeInteger(message.chat?.id) || message.from.id <= 0 || message.chat.id !== message.from.id || message.from.is_bot) return;
  const telegramUserId = String(message.from.id), chatId = String(message.chat.id);
  const match = typeof message.text === 'string' ? message.text.match(/^\/start(?:@\w+)?\s+([a-f0-9]{32})$/i) : null;
  if (match) { await repo.consumeLinkCode({ codeHash: await digest(match[1]), telegramUserId, chatId }); return; }
  const link = await repo.getTelegramLink(telegramUserId);
  if (!link || link.chat_id !== chatId) return;
  const audio = message.voice || message.audio;
  if (!audio || typeof audio.file_id !== 'string') return;
  const existing = await repo.getDraft(`telegram_${update.update_id}`);
  if (existing) return;
  const tooLarge = audio.file_size !== undefined && (!Number.isSafeInteger(audio.file_size) || audio.file_size < 1 || audio.file_size > MAX_AUDIO_BYTES);
  await repo.createDraft({ id: `telegram_${update.update_id}`, userId: link.user_id, source: 'telegram', status: tooLarge ? 'failed' : 'pending', fileId: audio.file_id, sourceMetadata: { telegram_update_id: update.update_id, expected_size: audio.file_size ?? null }, fields: {} });
  if (tooLarge) await repo.updateDraft(`telegram_${update.update_id}`, { error: 'حجم ویس از ۲۰ مگابایت بیشتر است.' });
}

export async function syncTelegram({ repo, supabase, fetcher = fetch, env = {} }) {
  const lock = crypto.randomUUID();
  if (!await repo.acquireLock('telegram', lock, 600000)) return { received: 0, processed: 0, failed: 0, busy: true };
  let received = 0, processed = 0, failed = 0;
  try {
    await cleanupAudio(repo, supabase);
    const config = await getConfig(repo, env);
    if (!config.telegramBotToken) fail('توکن بات تلگرام را وارد کنید.', 503, 'TELEGRAM_NOT_CONFIGURED');
    const offset = Number(await repo.getSetting('telegram_offset') || 0);
    const updates = await fetchTelegramUpdates({ token: config.telegramBotToken, offset, fetcher });
    const ingested = await repo.ingestUpdates(updates);
    received = ingested.inserted || 0;
    for (const item of await repo.listPendingUpdates(30)) {
      try {
        await consumeUpdate(repo, object(item.payload) ? item.payload : JSON.parse(item.payload));
        await repo.setUpdateStatus(item.update_id, 'processed');
      } catch { failed++; await repo.setUpdateStatus(item.update_id, 'pending', 'دریافت پیام کامل نشد؛ در همگام‌سازی بعدی دوباره تلاش می‌شود.'); }
    }
    if (config.aiApiKey && config.aiModel) for (const item of await repo.pendingTelegramDrafts(1)) {
      const result = await processDraft({ repo, supabase, id: item.id, fetcher, env });
      if (result?.status === 'ready') processed++;
      else if (result?.status === 'failed') failed++;
    }
    return { received, processed, failed, ...(!config.aiApiKey || !config.aiModel ? { warning: 'ویس‌ها دریافت شدند؛ برای پردازش، اتصال هوش مصنوعی را تکمیل کنید.' } : {}) };
  } finally { await repo.releaseLock('telegram', lock); }
}

/** Called only after Edge authentication and origin checks; no unauthenticated sync bypass. */
export async function handleVoice({ path, request, supabase, repo, user, fetcher = fetch, env = {} }) {
  const paths = new Set(['/api/voice', '/api/integrations', '/api/telegram/link', '/api/telegram/unlink', '/api/telegram/sync', '/api/voice/text', '/api/voice/retry', '/api/voice/submit', '/api/voice/upload-url', '/api/voice/upload-complete', '/api/voice/audio']);
  if (!paths.has(path)) return null;
  canVoice(user);
  if (path === '/api/voice' && request.method === 'GET') {
    if (user.role === 'manager') await cleanupAudio(repo, supabase);
    const config = await getConfig(repo, env);
    const rows = await repo.listDrafts(user.role === 'manager' ? null : user.id, 100);
    const links = await repo.listTelegramLinks(user.role === 'manager' ? null : user.id);
    const { state } = await repo.loadState();
    return json({ drafts: rows.map(draftView), integration: safeConfig(config), telegram: { configured: Boolean(config.telegramBotToken), botUsername: config.botUsername, linked: links.some(link => link.user_id === user.id), ...(user.role === 'manager' ? { links: links.map(link => ({ telegramUserId: link.telegram_user_id, userId: link.user_id, name: state.users.find(user => user.id === link.user_id)?.name || 'عضو تیم' })) } : {}) } });
  }
  if (request.method !== 'POST') return json({ error: 'روش درخواست مجاز نیست.', code: 'METHOD_NOT_ALLOWED' }, 405);
  const payload = await readJSON(request);
  if (path === '/api/voice/audio') {
    await rate(repo, `voice-audio:${user.id}`, 30);
    let row = await draftFor(repo, payload.id, user);
    retainedAudio(row);
    if (row.source === 'telegram' && !row.storage_path) row = (await cacheTelegramAudio({ repo, supabase, row, config: await getConfig(repo, env), fetcher })).row;
    const { bucket, path: audioPath, metadata } = await audioInfo(supabase, row);
    const ttl = Math.min(PLAYBACK_URL_SECONDS, Math.floor((audioDeadline(row) - Date.now()) / 1000));
    if (ttl < 1) fail('مهلت هفت‌روزهٔ نگه‌داری صوت پایان یافته است.', 410, 'AUDIO_EXPIRED');
    const { data, error } = await bucket.createSignedUrl(audioPath, ttl);
    let url;
    try {
      url = new URL(data?.signedUrl);
      if (url.protocol !== 'https:' || !url.hostname.endsWith('.supabase.co') || url.pathname !== `/storage/v1/object/sign/${BUCKET}/${audioPath}` || !url.searchParams.get('token')) throw Error();
      if (supabase.supabaseUrl && url.origin !== new URL(supabase.supabaseUrl).origin) throw Error();
    } catch { fail('آماده‌سازی پخش صوت انجام نشد؛ دوباره تلاش کنید.', 503, 'AUDIO_URL_FAILED'); }
    if (error) fail('آماده‌سازی پخش صوت انجام نشد؛ دوباره تلاش کنید.', 503, 'AUDIO_URL_FAILED');
    return json({ url: url.toString(), expiresAt: new Date(Date.now() + ttl * 1000).toISOString(), mimeType: metadata.mime_type || 'audio/ogg', fileName: metadata.file_name || 'arios-voice.ogg' });
  }
  if (path === '/api/integrations') {
    manager(user); await rate(repo, `integrations:${user.id}`, 10);
    const current = await getConfig(repo, env);
    const base = payload.aiBaseUrl === undefined ? current.aiBaseUrl : text(payload.aiBaseUrl, 'نشانی سرویس', 120);
    if (!['https://api.avalai.ir/v1', 'https://api.openai.com/v1', 'https://api.groq.com/openai/v1'].includes(base)) fail('سرویس پشتیبانی‌شده را انتخاب کنید.');
    if (base !== current.aiBaseUrl && !payload.aiApiKey?.trim()) fail('برای تغییر سرویس، کلید اختصاصی همان سرویس را وارد کنید.');
    if (base !== current.aiBaseUrl && payload.aiApiKey?.trim() === current.aiApiKey) fail('کلید سرویس قبلی برای تغییر سرویس قابل استفاده نیست؛ کلید اختصاصی سرویس انتخاب‌شده را وارد کنید.');
    const changedProvider = base !== current.aiBaseUrl;
    const defaults = base === 'https://api.groq.com/openai/v1' ? { aiModel: 'openai/gpt-oss-20b', transcriptionModel: 'whisper-large-v3-turbo' } : { aiModel: 'gpt-4o-mini', transcriptionModel: 'whisper-1' };
    const next = { ...current, aiBaseUrl: base, aiModel: payload.aiModel === undefined ? changedProvider ? defaults.aiModel : current.aiModel : text(payload.aiModel, 'مدل گزارش‌ساز', 100), transcriptionModel: payload.transcriptionModel === undefined ? changedProvider ? defaults.transcriptionModel : current.transcriptionModel : text(payload.transcriptionModel, 'مدل رونویسی', 100) };
    for (const model of [next.aiModel, next.transcriptionModel]) if (model && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model)) fail('شناسه مدل هوش مصنوعی معتبر نیست.');
    if (payload.aiApiKey?.trim()) { next.aiApiKey = text(payload.aiApiKey, 'کلید هوش مصنوعی', 512); if (/\s/.test(next.aiApiKey)) fail('کلید هوش مصنوعی معتبر نیست.'); }
    if (payload.telegramBotToken?.trim()) {
      next.telegramBotToken = text(payload.telegramBotToken, 'توکن بات', 200);
      if (!/^\d{5,20}:[A-Za-z0-9_-]{20,100}$/.test(next.telegramBotToken)) fail('قالب توکن بات معتبر نیست.');
      const bot = await telegramIdentity(next, 'getMe', fetcher);
      if (!Number.isSafeInteger(bot?.id) || bot.id <= 0 || bot.is_bot !== true || typeof bot.username !== 'string') fail('پاسخ شناسایی بات تلگرام معتبر نیست.', 502, 'TELEGRAM_INVALID_RESPONSE');
      const webhook = await telegramIdentity(next, 'getWebhookInfo', fetcher);
      if (!object(webhook) || typeof webhook.url !== 'string') fail('وضعیت وب‌هوک تلگرام معتبر نیست.', 502, 'TELEGRAM_INVALID_RESPONSE');
      if (webhook.url) fail('این بات به وب‌هوک دیگری وصل است؛ برای آریوس بات اختصاصی استفاده کنید یا وب‌هوک قبلی را خودتان بردارید.', 409, 'BOT_HAS_WEBHOOK');
      next.botUsername = bot.username; next.botId = String(bot.id);
      if (current.botId && current.botId !== next.botId) {
        if (await repo.hasTelegramHistory()) fail('این فضا سابقهٔ بات فعلی را دارد؛ توکن همان بات را وارد کنید. برای بات دیگر فضای جداگانه بسازید.', 409, 'BOT_HAS_HISTORY');
      }
    }
    await repo.setSetting('integrations', next);
    return json({ integration: safeConfig(next), telegram: { configured: Boolean(next.telegramBotToken), botUsername: next.botUsername } });
  }
  if (path === '/api/telegram/link') {
    await rate(repo, `telegram-link:${user.id}`, 10);
    const config = await getConfig(repo, env);
    if (!config.telegramBotToken) fail('ابتدا بات اختصاصی آریوس را متصل کنید.', 503, 'TELEGRAM_NOT_CONFIGURED');
    const target = payload.userId || user.id;
    if (target !== user.id) manager(user);
    const { state } = await repo.loadState();
    canVoice(state.users.find(user => user.id === target));
    const code = crypto.randomUUID().replaceAll('-', ''), expiresAt = new Date(Date.now() + 600000).toISOString();
    await repo.createLinkCode({ codeHash: await digest(code), userId: target, expiresAt });
    return json({ code, expiresAt, botUsername: config.botUsername });
  }
  if (path === '/api/telegram/unlink') {
    const target = payload.userId || user.id;
    if (target !== user.id) manager(user);
    await repo.unlinkTelegram(target);
    return json({ ok: true });
  }
  if (path === '/api/telegram/sync') { manager(user); await rate(repo, 'telegram-sync', 4); return json(await syncTelegram({ repo, supabase, fetcher, env })); }
  if (path === '/api/voice/text') {
    await rate(repo, `voice:${user.id}`, 10);
    const transcript = text(payload.transcript, 'متن گزارش', 16000);
    const { state } = await repo.loadState();
    if (payload.projectId && !projectAccess(state, user.id, payload.projectId)) fail('پروژه مجاز نیست.', 403, 'FORBIDDEN');
    const row = await repo.createDraft({ id: crypto.randomUUID(), userId: user.id, source: 'text', transcript, fields: { projectId: payload.projectId || null } });
    return json(await processDraft({ repo, supabase, id: row.id, fetcher, env }));
  }
  if (path === '/api/voice/upload-url') {
    await rate(repo, `voice-upload:${user.id}`, 10);
    const metadata = uploadMetadata(payload);
    const { state } = await repo.loadState();
    if (payload.projectId && !projectAccess(state, user.id, payload.projectId)) fail('پروژه مجاز نیست.', 403, 'FORBIDDEN');
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(user.id)) fail('شناسه حساب برای بارگذاری معتبر نیست.', 400, 'INVALID_USER_ID');
    const id = crypto.randomUUID(), storagePath = `voice/${user.id}/${id}.${metadata.extension}`;
    await repo.createDraft({ id, userId: user.id, source: 'upload', fields: { projectId: payload.projectId || null }, sourceMetadata: metadata, storagePath });
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(storagePath, { upsert: false });
    if (error || !data?.signedUrl || !data?.token) { await repo.updateDraft(id, { status: 'failed', error: 'آماده‌سازی بارگذاری انجام نشد؛ فایل را دوباره انتخاب کنید.' }); fail('آماده‌سازی بارگذاری انجام نشد؛ دوباره تلاش کنید.', 503, 'UPLOAD_URL_FAILED'); }
    return json({ draftId: id, uploadUrl: data.signedUrl, token: data.token, path: data.path || storagePath });
  }
  if (path === '/api/voice/upload-complete') {
    const row = await draftFor(repo, payload.id, user);
    if (row.source !== 'upload') fail('این پیش‌نویس از بارگذاری فایل ساخته نشده است.', 400, 'INVALID_UPLOAD');
    if (['ready', 'submitted', 'processing'].includes(row.status)) return json(draftView(row));
    // Metadata and bytes are verified inside the claimed processing job, so a failed finalize stays retryable.
    return json(await processDraft({ repo, supabase, id: row.id, fetcher, env }));
  }
  if (path === '/api/voice/retry') {
    await rate(repo, `voice:${user.id}`, 10);
    const row = await draftFor(repo, payload.id, user);
    if (row.status === 'submitted') fail('این پیش‌نویس قبلاً ارسال شده است.', 409, 'ALREADY_SUBMITTED');
    return json(await processDraft({ repo, supabase, id: row.id, fetcher, env }));
  }
  if (path === '/api/voice/submit') {
    const row = await draftFor(repo, payload.id, user);
    if (!['ready', 'submitted'].includes(row.status)) fail('ابتدا پردازش پیش‌نویس را کامل کنید.', 409, 'DRAFT_NOT_READY');
    if (!object(payload.fields)) fail('جزئیات گزارش معتبر نیست.');
    const saved = await repo.mutateState(state => {
      const existing = state.reports.find(report => report.sourceDraftId === row.id);
      if (existing) return { id: existing.id, canonicalFields: Object.fromEntries(['projectId', 'workerId', 'date', 'start', 'end', 'breakMinutes', 'description', 'output'].map(key => [key, existing[key]])) };
      const owner = state.users.find(owner => owner.id === row.user_id); canVoice(owner);
      const fields = Object.fromEntries(['projectId', 'workerId', 'date', 'start', 'end', 'breakMinutes', 'description', 'output'].filter(key => payload.fields[key] !== undefined).map(key => [key, payload.fields[key]]));
      if (owner.role === 'worker') {
        if (fields.workerId && fields.workerId !== owner.id) fail('گزارش به نام فرستندهٔ ویس ثبت می‌شود.', 403, 'FORBIDDEN');
        fields.workerId = owner.id;
      }
      if (fields.breakMinutes === null || fields.breakMinutes === undefined) fail('مدت استراحت را پیش از ثبت مشخص کنید.');
      const result = applyAction(state, user.id, 'report.create', fields);
      const report = state.reports.find(report => report.id === result.id);
      report.sourceDraftId = row.id; report.source = row.source;
      return { id: result.id, canonicalFields: Object.fromEntries(['projectId', 'workerId', 'date', 'start', 'end', 'breakMinutes', 'description', 'output'].map(key => [key, report[key]])) };
    });
    await repo.updateDraft(row.id, { status: 'submitted', report_id: saved.result.id, fields: saved.result.canonicalFields });
    return json({ result: { id: saved.result.id }, state: publicState(saved.state, user.id) });
  }
  return null;
}
