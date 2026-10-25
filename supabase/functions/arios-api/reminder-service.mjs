/** Private scheduled Telegram delivery. A receipt is durable before another send is attempted. */
import { APIError, manager, sha256 } from './auth.mjs';
import { getConfig, receiveTelegramUpdates } from './voice-service.mjs';

const ZONE = 'Asia/Tehran';
const HASH_SETTING = 'telegram_scheduler_auth_hash';
const CONFIG_SETTING = 'telegram_reminders';
const fail = (message, status = 400, code = 'INVALID_INPUT') => { throw new APIError(message, status, code); };
const clean = (value, max = 200) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, max) : '';
const statuses = ['pending', 'sending', 'sent', 'failed', 'unknown', 'cancelled'];
const settingObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export function tehranReminderWindow(at = Date.now()) {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) throw new TypeError('Invalid reminder time');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, calendar: 'gregory', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map(item => [item.type, item.value]));
  const localDate = `${parts.year}-${parts.month}-${parts.day}`;
  const next = new Date(`${localDate}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
  return { localDate, targetDate: next.toISOString().slice(0, 10), hour: Number(parts.hour), minute: Number(parts.minute), eligible: Number(parts.hour) === 21 };
}

/** Only actual assigned, open tasks and a currently linked active worker enter a message. */
export function buildReminderPlans(state, links, targetDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) throw new TypeError('Invalid target date');
  const users = Array.isArray(state?.users) ? state.users : [], projects = Array.isArray(state?.projects) ? state.projects : [];
  const linked = new Map((Array.isArray(links) ? links : []).filter(link => /^\d{1,20}$/.test(String(link.chat_id)) && String(link.chat_id) === String(link.telegram_user_id)).map(link => [link.user_id, link]));
  return users.filter(user => user.role === 'worker' && !user.deletedAt && linked.has(user.id)).flatMap(user => {
    const tasks = projects.filter(project => project.status !== 'completed' && (project.memberIds || []).includes(user.id)).flatMap(project => (project.tasks || []).filter(task => task.assigneeId === user.id && task.dueDate === targetDate && ['open', 'in_progress'].includes(task.status)).map(task => ({ project, task })));
    if (!tasks.length) return [];
    const label = new Intl.DateTimeFormat('fa-IR', { timeZone: ZONE, dateStyle: 'full' }).format(new Date(targetDate + 'T12:00:00Z'));
    const lines = [`${clean(user.name, 80) || 'همکار آریوس'}، برنامهٔ فردای شما`, label, ''];
    let included = 0;
    for (const {project, task} of tasks) {
      const line = `${included + 1}. ${clean(project.name, 130)} — ${clean(task.title, 220)}${clean(task.description, 280) ? '\n' + clean(task.description, 280) : ''}`;
      if (lines.join('\n').length + line.length > 3450) break;
      lines.push(line); included++;
    }
    if (included < tasks.length) lines.push(`و ${tasks.length - included} وظیفهٔ دیگر؛ جزئیات کامل در پنل آریوس است.`);
    lines.push('', 'جزئیات و وضعیت کار را در پنل آریوس بررسی کنید.', 'https://arios-rouge.vercel.app/login/team');
    return [{ userId: user.id, chatId: String(linked.get(user.id).chat_id), body: lines.join('\n'), taskCount: tasks.length }];
  });
}

function sameHash(a, b) {
  if (!/^[a-f0-9]{64}$/.test(a || '') || !/^[a-f0-9]{64}$/.test(b || '')) return false;
  let different = 0; for (let i = 0; i < 64; i++) different |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return different === 0;
}

async function schedulerAuthorization(repo, request) {
  const token = request.headers.get('x-arios-scheduler-token') || '';
  if (!/^[a-f0-9]{64}$/.test(token)) fail('دسترسی زمان‌بند معتبر نیست.', 401, 'SCHEDULER_UNAUTHORIZED');
  const expected = await repo.getSetting(HASH_SETTING);
  if (!sameHash(typeof expected === 'string' ? expected : '', await sha256(token))) fail('دسترسی زمان‌بند معتبر نیست.', 401, 'SCHEDULER_UNAUTHORIZED');
}

async function telegramJSON(response) {
  const reader = response.body?.getReader(); if (!reader) throw new Error('Invalid response');
  const chunks = []; let size = 0;
  try {
    for (;;) { const {done, value} = await reader.read(); if (done) break; size += value.byteLength; if (size > 32768) { await reader.cancel().catch(() => {}); throw new Error('Large response'); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** An uncertain network response may already have reached Telegram: it is never retried automatically. */
export async function sendTelegramReminder({ token, chatId, body, fetcher = fetch, timeoutMs = 8000 }) {
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token || '')) return { status: 'failed', errorCode: 'TELEGRAM_TOKEN_INVALID', stop: true };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({chat_id: chatId, text: body, link_preview_options: {is_disabled: true}}), redirect: 'manual', signal: controller.signal });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel().catch(() => {}); return {status: 'failed', errorCode: 'TELEGRAM_REDIRECT'}; }
    let value; try { value = await telegramJSON(response); } catch { return {status: 'unknown', errorCode: 'TELEGRAM_RESPONSE_UNCERTAIN'}; }
    if (response.ok && value?.ok === true && Number.isSafeInteger(value.result?.message_id)) return {status: 'sent', messageId: String(value.result.message_id)};
    const code = Number(value?.error_code) || response.status;
    if (code === 429 && value?.ok === false) return {status: 'pending', errorCode: 'TELEGRAM_RATE_LIMITED', retryAfterMs: Math.max(60000, Math.min(3600000, Number(value.parameters?.retry_after) * 1000 || 60000))};
    if ([401, 404].includes(code) && value?.ok === false) return {status: 'failed', errorCode: 'TELEGRAM_TOKEN_INVALID', stop: true};
    if (code === 403 && value?.ok === false) return {status: 'failed', errorCode: 'TELEGRAM_BLOCKED'};
    if (code >= 400 && code < 500 && value?.ok === false) return {status: 'failed', errorCode: 'TELEGRAM_REQUEST_REJECTED'};
    return {status: 'unknown', errorCode: 'TELEGRAM_RESPONSE_UNCERTAIN'};
  } catch { return {status: 'unknown', errorCode: 'TELEGRAM_DELIVERY_UNCERTAIN'}; }
  finally { clearTimeout(timer); controller.abort(); }
}

export async function dispatchNightlyReminders({ repo, config, fetcher = fetch, at = Date.now(), clock = Date.now, pause = wait, maxRecipients = 40 }) {
  const time = tehranReminderWindow(at), settings = settingObject(await repo.getSetting(CONFIG_SETTING));
  const summary = {sent: 0, failed: 0, unknown: 0, pending: 0, cancelled: 0, targetDate: time.targetDate};
  if (settings.enabled === false || !time.eligible || !config.telegramBotToken) return {...summary, skipped: true};
  const deferredUntil = Date.parse(await repo.getSetting('telegram_reminder_defer_until') || '');
  if (Number.isFinite(deferredUntil) && deferredUntil > at) return {...summary, deferred: true};
  const lock = crypto.randomUUID();
  if (!(await repo.acquireLock('telegram-reminders', lock, 90000))) return {...summary, busy: true};
  const started = clock();
  try {
    // Another tick may have installed a rate-limit hold while this one awaited the lock.
    const lockedHold = Date.parse(await repo.getSetting('telegram_reminder_defer_until') || '');
    if (Number.isFinite(lockedHold) && lockedHold > clock()) return {...summary, deferred: true};
    if (settingObject(await repo.getSetting(CONFIG_SETTING)).enabled === false) return {...summary, skipped: true};
    const loaded = await repo.loadState(); if (!loaded?.state) fail('فضای کار آماده نیست.', 503, 'STATE_NOT_INITIALIZED');
    const plans = buildReminderPlans(loaded.state, await repo.listTelegramLinks(), time.targetDate);
    await repo.enqueueReminders(time.targetDate, plans);
    for (let i = 0; i < Math.min(100, Math.max(1, maxRecipients)); i++) {
      if (clock() - started > 45000 || !tehranReminderWindow(clock()).eligible) break;
      const claim = crypto.randomUUID(), row = await repo.claimReminder({targetDate: time.targetDate, claim, leaseMs: 120000});
      if (!row) break;
      if (settingObject(await repo.getSetting(CONFIG_SETTING)).enabled === false) {
        await repo.finishReminder({id: row.id, claim, status: 'cancelled', errorCode: 'REMINDERS_DISABLED'}); summary.cancelled++; break;
      }
      // Re-read after claiming: revoked project access, archived members, unlinks and edited tasks take effect before delivery.
      const current = await repo.loadState(), links = await repo.listTelegramLinks();
      const plan = buildReminderPlans(current?.state, links, time.targetDate).find(plan => plan.userId === row.user_id);
      if (!plan || plan.chatId !== String(row.chat_id)) {
        await repo.finishReminder({id: row.id, claim, status: 'cancelled', errorCode: 'ASSIGNMENT_OR_LINK_CHANGED'}); summary.cancelled++; continue;
      }
      const outcome = await sendTelegramReminder({token: config.telegramBotToken, chatId: plan.chatId, body: plan.body, fetcher});
      // If persisting this acknowledgement fails, leave sending behind; its expired lease becomes unknown, never a second send.
      const finished = await repo.finishReminder({id: row.id, claim, ...outcome});
      if (!finished) fail('نتیجهٔ ارسال هنوز قابل تأیید نیست.', 503, 'REMINDER_ACK_UNCERTAIN');
      summary[outcome.status]++;
      if (outcome.status === 'pending') {
        await repo.setSetting('telegram_reminder_defer_until', new Date(clock() + outcome.retryAfterMs).toISOString());
        break;
      }
      if (outcome.stop) break;
      await pause(45);
    }
    return summary;
  } finally { await repo.releaseLock('telegram-reminders', lock); }
}

export async function reminderStatus({repo, user, at = Date.now()}) {
  manager(user);
  const [loaded, links, settings, config, hash, rows, tick] = await Promise.all([repo.loadState(), repo.listTelegramLinks(), repo.getSetting(CONFIG_SETTING), getConfig(repo), repo.getSetting(HASH_SETTING), repo.listReminders({limit: 100}), repo.getSetting('telegram_reminder_last_tick')]);
  const time = tehranReminderWindow(at), state = loaded?.state || {}, plans = buildReminderPlans(state, links, time.targetDate);
  const workers = new Set((state.users || []).filter(person => person.role === 'worker' && !person.deletedAt).map(person => person.id));
  const summary = Object.fromEntries(statuses.map(status => [status, (rows || []).filter(row => row.target_date === time.targetDate && row.status === status).length]));
  return {enabled: settingObject(settings).enabled !== false, configured: Boolean(config.telegramBotToken), schedulerConfigured: /^[a-f0-9]{64}$/.test(hash || ''), time: '21:00', timezone: ZONE, targetDate: time.targetDate, linkedCount: (links || []).filter(link => workers.has(link.user_id)).length, assignedCount: plans.length, lastTickAt: typeof tick?.at === 'string' ? tick.at : null, summary, deliveries: (rows || []).map(row => ({id: row.id, userId: row.user_id, name: (state.users || []).find(person => person.id === row.user_id)?.name || 'عضو تیم', targetDate: row.target_date, status: statuses.includes(row.status) ? row.status : 'unknown', taskCount: row.task_count, attempts: row.attempts, errorCode: row.error_code || null, sentAt: row.sent_at || null, nextAttemptAt: row.next_attempt_at || null, updatedAt: row.updated_at}))};
}

export async function handleReminders({repo, user, request, path, fetcher = fetch, readJSON, json, env = {}, at = Date.now(), clock = Date.now, pause = wait}) {
  if (!['/api/internal/telegram-tick', '/api/reminders', '/api/reminders/settings'].includes(path)) return null;
  if (path === '/api/internal/telegram-tick') {
    if (request.method !== 'POST') fail('روش درخواست مجاز نیست.', 405, 'METHOD_NOT_ALLOWED');
    await schedulerAuthorization(repo, request);
    await readJSON(request, 1024);
    // Receive account starts and voice metadata without invoking an AI provider or sending a reply.
    let received;
    try { received = await receiveTelegramUpdates({repo, fetcher, env, maxPending: 100}); }
    catch { received = {received: 0, errorCode: 'TELEGRAM_RECEIVE_FAILED'}; }
    const result = await dispatchNightlyReminders({repo, config: await getConfig(repo, env), fetcher, at, clock, pause});
    await repo.setSetting('telegram_reminder_last_tick', {at: new Date(at).toISOString(), received: Number(received.received) || 0, ...(received.errorCode ? {receiveErrorCode: received.errorCode} : {}), ...result});
    return json({ok: true, received: Number(received.received) || 0, ...(received.errorCode ? {receiveErrorCode: received.errorCode} : {}), ...result});
  }
  manager(user);
  if (path === '/api/reminders' && request.method === 'GET') return json(await reminderStatus({repo, user, at}));
  if (path === '/api/reminders/settings' && request.method === 'POST') {
    const payload = await readJSON(request, 1024);
    if (typeof payload.enabled !== 'boolean') fail('وضعیت یادآوری معتبر نیست.');
    await repo.setSetting(CONFIG_SETTING, {enabled: payload.enabled, time: '21:00', timezone: ZONE});
    return json(await reminderStatus({repo, user, at}));
  }
  fail('روش درخواست مجاز نیست.', 405, 'METHOD_NOT_ALLOWED');
}
