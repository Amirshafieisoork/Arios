import { applyAction } from './domain.mjs';
import { normalizePhone, normalizeUsername, loginIdentity, phoneAuthEmail, internalAuthEmail } from './identity.mjs';
/** Authentication is resolved from Supabase Auth and private profiles only. */
export class APIError extends Error {
  constructor(message, status = 400, code = 'INVALID_INPUT') {
    super(message); this.name = 'APIError'; this.status = status; this.code = code;
  }
}
const fail = (message, status = 400, code = 'INVALID_INPUT') => { throw new APIError(message, status, code); };
export const safeUser = user => user ? Object.fromEntries(['id', 'name', 'email', 'phone', 'username', 'role', 'department', 'skill', 'deletedAt'].filter(key => user[key] !== undefined && !(key === 'email' && internalAuthEmail(user[key]))).map(key => [key, user[key]])) : null;
export function text(value, label, max = 4000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${label} معتبر نیست.`);
  return value.trim();
}
export function emailValue(value) {
  const email = text(value, 'ایمیل', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('ایمیل معتبر نیست.');
  return email;
}
export function passwordValue(value) {
  if (typeof value !== 'string' || value.length < 6 || value.length > 128) fail('رمز عبور باید بین ۶ و ۱۲۸ نویسه باشد.');
  return value;
}
export function manager(user) {
  if (user?.role !== 'manager') fail('این عملیات فقط برای مدیر مجاز است.', 403, 'FORBIDDEN');
}
export const sha256 = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))).map(value => value.toString(16).padStart(2, '0')).join('');
const sameHash = (left, right) => {
  if (typeof left !== 'string' || typeof right !== 'string' || !/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  let different = 0;
  for (let i = 0; i < 64; i += 1) different |= left.toLowerCase().charCodeAt(i) ^ right.toLowerCase().charCodeAt(i);
  return different === 0;
};
export async function rate(repo, key, limit, windowMs = 60000) {
  const result = await repo.rateLimit(key, limit, windowMs);
  if (!result.allowed) fail('تعداد درخواست‌ها زیاد است؛ کمی بعد دوباره تلاش کنید.', 429, 'RATE_LIMITED');
}

export async function authenticate(request, client, repo) {
  const header = request.headers.get('authorization') || '';
  const match = header.match(/^Bearer\s+([^\s]+)$/i);
  if (!match || match[1].length > 8192) fail('برای ادامه وارد حساب خود شوید.', 401, 'UNAUTHORIZED');
  let response;
  try { response = await client.auth.getUser(match[1]); }
  catch { fail('سرویس بررسی ورود موقتاً در دسترس نیست.', 503, 'AUTH_UNAVAILABLE'); }
  if (response.error?.status >= 500 || response.error?.status === 429 || response.error?.name === 'AuthRetryableFetchError') fail('سرویس بررسی ورود موقتاً در دسترس نیست.', 503, 'AUTH_UNAVAILABLE');
  if (response.error || !response.data?.user?.id) fail('نشست معتبر نیست؛ دوباره وارد شوید.', 401, 'INVALID_SESSION');
  const profile = await repo.getProfile(response.data.user.id);
  if (!profile || !['manager', 'worker', 'customer', 'warehouse', 'accountant'].includes(profile.role)) fail('این حساب به فضای کار آریوس دسترسی ندارد.', 403, 'NOT_A_MEMBER');
  const loaded = await repo.loadState();
  if (!loaded) fail('راه‌اندازی فضای کار هنوز کامل نشده است.', 503, 'STATE_NOT_INITIALIZED');
  const user = loaded.state.users.find(user => user.id === profile.domain_user_id);
  if (!user || user.deletedAt || user.role !== profile.role) fail('دسترسی حساب نیازمند بررسی مدیر است.', 403, 'PROFILE_MISMATCH');
  await verifySessionSecurity(repo, user.id, response.data.user.id, match[1]);
  return { user, authUser: response.data.user, state: loaded.state, revision: loaded.revision };
}

export function emptyState(email) {
  return { schemaVersion: 1, users: [{ id: 'manager', name: 'مدیر آریوس', email, role: 'manager' }], projects: [], reports: [], materials: [], invoices: [], messages: [], tickets: [], inventory: [], receipts: [], audit: [] };
}

async function createAuthUser(client, { email, password, name, phone }) {
  let response;
  try { response = await client.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name, ...(phone ? { phone } : {}) } }); }
  catch { fail('ساخت حساب فعلاً انجام نشد؛ دوباره تلاش کنید.', 502, 'AUTH_UNAVAILABLE'); }
  if (response.error || !response.data?.user?.id) {
    const duplicate = ['email_exists', 'user_already_exists'].includes(response.error?.code);
    fail(duplicate ? 'این حساب قبلاً ساخته شده است؛ اطلاعات آن را ویرایش کنید.' : 'حساب ایجاد نشد؛ شماره تماس و رمز را بررسی کنید.', duplicate ? 409 : 400, duplicate ? 'DUPLICATE_ACCOUNT' : 'AUTH_CREATE_FAILED');
  }
  return response.data.user;
}

/** Never delete an Auth user after an uncertain database commit. */
async function recoverCreatedAccount(client, repo, authUserId, domainUserId, { allowCleanup = false } = {}) {
  let profile;
  try { profile = await repo.getProfile(authUserId); }
  catch { fail('وضعیت ساخت حساب هنوز قطعی نیست؛ مدیر باید اتصال حساب را بررسی کند.', 503, 'ACCOUNT_SETUP_PENDING'); }
  if (profile) {
    if (profile.domain_user_id !== domainUserId) fail('اتصال حساب نیازمند بررسی مدیر است.', 503, 'ACCOUNT_SETUP_PENDING');
    return true;
  }
  // A missing profile can be a stale read while the original RPC is still
  // completing. Only a definite non-commit permits deleting the fresh identity.
  if (!allowCleanup) fail('نتیجهٔ ساخت حساب هنوز قطعی نیست؛ هویت ورود حفظ شده است و مدیر باید وضعیت اتصال را دوباره بررسی کند.', 503, 'ACCOUNT_SETUP_PENDING');
  try {
    const response = await client.auth.admin.deleteUser(authUserId);
    if (response.error) throw response.error;
  } catch { fail('ساخت حساب کامل نشد؛ اتصال حساب باید توسط مدیر بررسی شود.', 503, 'ACCOUNT_SETUP_PENDING'); }
  return false;
}

export async function bootstrap(client, repo, payload) {
  await rate(repo, 'bootstrap', 10, 60000);
  const code = text(payload.code, 'کد راه‌اندازی', 256);
  const email = emailValue(payload.email);
  const setting = await repo.getSetting('bootstrap');
  const codeHash = await sha256(code);
  const expiresAt = typeof setting?.expiresAt === 'number' ? setting.expiresAt : Date.parse(setting?.expiresAt || '');
  if (!setting || !sameHash(codeHash, setting.codeHash) || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || email !== String(setting.ownerEmail || '').trim().toLowerCase()) {
    fail('کد راه‌اندازی معتبر نیست یا مهلت آن گذشته است.', 403, 'BOOTSTRAP_INVALID');
  }
  const loaded = await repo.loadState();
  const state = loaded ? structuredClone(loaded.state) : emptyState(email);
  const owner = state.users.find(user => user.role === 'manager' && user.email?.toLowerCase() === email);
  if (!owner) fail('اطلاعات مدیر با فضای کار موجود سازگار نیست.', 409, 'BOOTSTRAP_OWNER_MISMATCH');
  if (await repo.getProfileByDomainId(owner.id)) fail('حساب مدیر قبلاً راه‌اندازی شده است.', 409, 'ALREADY_INITIALIZED');
  const password = passwordValue(payload.password);
  const authUser = await createAuthUser(client, { email, password, name: owner.name });
  let commitUncertain = false;
  try {
    commitUncertain = true;
    const committed = await repo.bootstrap({ authUserId: authUser.id, state, codeHash });
    if (typeof committed !== 'boolean') fail('پاسخ راه‌اندازی حساب قطعی نیست؛ وضعیت اتصال باید دوباره بررسی شود.', 503, 'ACCOUNT_SETUP_PENDING');
    commitUncertain = false;
    if (!committed) fail('راه‌اندازی حساب کامل نشد؛ دوباره تلاش کنید.', 409, 'BOOTSTRAP_CONFLICT');
  } catch (error) {
    if (!await recoverCreatedAccount(client, repo, authUser.id, owner.id, { allowCleanup: !commitUncertain })) throw error;
  }
  return { ok: true, user: safeUser(owner) };
}

function accountInState(state, actorId, payload, domainUserId) {
  manager(state.users.find(user => user.id === actorId));
  const name = text(payload.name, 'نام', 120);
  const phone = payload.phone ? normalizePhone(payload.phone) : null;
  const email = payload.email ? emailValue(payload.email) : null;
  const username = payload.username ? normalizeUsername(payload.username) : null;
  if (!phone && !email && !username) fail('شماره تماس را وارد کنید.');
  if (!['worker', 'customer', 'warehouse', 'accountant'].includes(payload.role)) fail('نقش حساب معتبر نیست.');
  if (payload.role === 'warehouse' && !username) fail('برای انباردار نام کاربری جداگانه وارد کنید.');
  const identityMatch = state.users.find(user => (phone && user.phone && normalizePhone(user.phone) === phone) || (username && user.username && normalizeUsername(user.username) === username) || (email && user.email?.toLowerCase() === email));
  if (identityMatch?.deletedAt) fail('این حساب بایگانی شده است؛ مدیر می‌تواند همان حساب را بازیابی کند.', 409, 'ACCOUNT_ARCHIVED');
  if (username && state.users.some(user => user.username && normalizeUsername(user.username) === username)) fail('این نام کاربری قبلاً ثبت شده است.', 409, 'DUPLICATE_USERNAME');
  if (phone && state.users.some(user => { try { return user.phone && normalizePhone(user.phone) === phone; } catch { return false; } })) fail('این شماره قبلاً ثبت شده است؛ نقش و اطلاعات همان حساب را ویرایش کنید.', 409, 'DUPLICATE_PHONE');
  if (email && state.users.some(user => user.email?.toLowerCase() === email)) fail('این ایمیل قبلاً در فضای کار ثبت شده است؛ همان حساب را ویرایش کنید.', 409, 'DUPLICATE_EMAIL');
  const projectIds = payload.projectIds ?? [];
  if (!Array.isArray(projectIds) || projectIds.length > 100 || projectIds.some(id => typeof id !== 'string' || !id || id.length > 120) || new Set(projectIds).size !== projectIds.length) fail('فهرست پروژه‌ها معتبر نیست.');
  const projects = projectIds.map(id => state.projects.find(project => project.id === id));
  if (projects.some(project => !project)) fail('پروژه یافت نشد.', 404, 'NOT_FOUND');
  if (payload.role === 'customer' && projects.some(project => project.customerId)) fail('پروژه از قبل مشتری دارد.', 409, 'PROJECT_OWNED');
  const user = { id: domainUserId, name, ...(phone ? { phone } : {}), ...(email ? { email } : {}), ...(username ? { username } : {}), role: payload.role, ...(payload.role === 'worker' ? { hourlyRate: 0, rateHistory: [] } : {}) };
  state.users.push(user);
  for (const project of projects) {
    if (user.role === 'customer') project.customerId = user.id;
    else if (user.role === 'worker') project.memberIds = [...new Set([...(project.memberIds || []), user.id])];
  }
  state.audit.push({ id: crypto.randomUUID(), actorId, action: 'account.create', entityId: user.id, createdAt: new Date().toISOString(), description: `حساب ${name} ایجاد شد.` });
  return user;
}

export async function createAccount(client, repo, actor, payload) {
  manager(actor);
  await rate(repo, `account-create:${actor.id}`, 10);
  const password = passwordValue(payload.password);
  const loaded = await repo.loadState();
  if (!loaded) fail('فضای کار آماده نیست.', 503, 'STATE_NOT_INITIALIZED');
  const domainUserId = `u_${crypto.randomUUID()}`;
  // Validate every domain field before creating an external Auth account.
  const candidate = accountInState(structuredClone(loaded.state), actor.id, payload, domainUserId);
  // Contact numbers can change or be reused. Keep the private Auth identity
  // immutable so a previous phone alias cannot reserve that number forever.
  const authUser = await createAuthUser(client, { email: candidate.email || `account.${domainUserId.slice(2)}@phone.arios.invalid`, name: candidate.name, phone: candidate.phone, password });
  let commitUncertain = false;
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = attempt === 0 ? loaded : await repo.loadState();
      if (!current) fail('فضای کار آماده نیست.', 503, 'STATE_NOT_INITIALIZED');
      const state = structuredClone(current.state);
      const user = accountInState(state, actor.id, payload, domainUserId);
      commitUncertain = true;
      const committed = await repo.commitAccount({ expectedRevision: current.revision, state, authUserId: authUser.id, domainUserId, role: user.role });
      if (typeof committed !== 'boolean') fail('پاسخ ساخت حساب قطعی نیست؛ وضعیت اتصال باید دوباره بررسی شود.', 503, 'ACCOUNT_SETUP_PENDING');
      commitUncertain = false;
      if (committed) return { result: safeUser(user), state };
    }
    fail('اطلاعات هم‌زمان تغییر کرد؛ دوباره تلاش کنید.', 409, 'STATE_CONFLICT');
  } catch (error) {
    if (await recoverCreatedAccount(client, repo, authUser.id, domainUserId, { allowCleanup: !commitUncertain })) {
      const current = await repo.loadState();
      if (!current) fail('وضعیت ساخت حساب نیازمند بررسی است.', 503, 'ACCOUNT_SETUP_PENDING');
      return { result: safeUser(current.state.users.find(user => user.id === domainUserId)), state: current.state };
    }
    throw error;
  }
}

/** Role and contact edits commit with the protected profile in one database transaction. */
export async function updateAccount(client, repo, actor, payload) {
  manager(actor);
  await rate(repo, `account-update:${actor.id}`, 20);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const loaded = await repo.loadState();
    if (!loaded) fail('فضای کار آماده نیست.', 503, 'STATE_NOT_INITIALIZED');
    const state = structuredClone(loaded.state);
    const result = applyAction(state, actor.id, 'account.update', payload);
    const profile = await repo.getProfileByDomainId(result.id);
    // Legacy staff records may predate Supabase Auth. Editing their contact or
    // role does not require creating a login or changing somebody's password.
    if (await repo.updateAccount({ expectedRevision: loaded.revision, state, authUserId: profile?.auth_user_id ?? null, domainUserId: result.id, role: result.role })) return { result: { ...safeUser(result), warnings: result.warnings || [], loginEnabled: Boolean(profile) }, state };
  }
  fail('اطلاعات هم‌زمان تغییر کرد؛ دوباره تلاش کنید.', 409, 'STATE_CONFLICT');
}

async function authResponseJSON(response) {
  const reader = response.body?.getReader();
  if (!reader) return {};
  let size = 0; const chunks = [];
  for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 1048576) { await reader.cancel(); fail('پاسخ سرویس ورود معتبر نیست.', 502, 'AUTH_UNAVAILABLE'); } chunks.push(next.value); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { fail('سرویس ورود پاسخ معتبری نداد.', 502, 'AUTH_UNAVAILABLE'); }
}

/** The private phone-to-Auth mapping is never returned to an anonymous caller. */
export async function passwordLogin({ client, repo, payload, authUrl, authKey, fetcher = fetch }) {
  const identity = loginIdentity(payload);
  const identifier = Object.values(identity)[0];
  if (typeof payload.password !== 'string' || !payload.password || payload.password.length > 128) fail('شماره تماس یا رمز عبور درست نیست.', 401, 'INVALID_CREDENTIALS');
  await rate(repo, 'phone-login:global', 120);
  await rate(repo, `phone-login:${await sha256(identifier)}`, 6);
  let target;
  try { target = new URL(authUrl); } catch { fail('سرویس ورود آماده نیست.', 503, 'AUTH_UNAVAILABLE'); }
  if (target.protocol !== 'https:' || !target.hostname.endsWith('.supabase.co') || target.pathname !== '/' || !authKey) fail('سرویس ورود آماده نیست.', 503, 'AUTH_UNAVAILABLE');
  const loaded = await repo.loadState();
  const user = findIdentityUser(loaded?.state, identity);
  const profile = user ? await repo.getProfileByDomainId(user.id) : null;
  let email = identity.phone ? phoneAuthEmail(identity.phone) : `unknown.${(await sha256(identifier)).slice(0,32)}@phone.arios.invalid`;
  if (profile && !user.deletedAt) {
    const security = await repo.getSetting?.(`auth-security:${user.id}`);
    if (security?.blocked && (!security.blockUntil || security.blockUntil > Date.now())) fail('اطلاعات ورود یا وضعیت حساب معتبر نیست.', 401, 'INVALID_CREDENTIALS');
    let existing;
    try { existing = await client.auth.admin.getUserById(profile.auth_user_id); }
    catch { fail('سرویس ورود موقتاً در دسترس نیست.', 503, 'AUTH_UNAVAILABLE'); }
    if (existing.error || !existing.data?.user?.email) fail('شماره تماس یا رمز عبور درست نیست.', 401, 'INVALID_CREDENTIALS');
    email = existing.data.user.email;
  }
  let response;
  try {
    response = await fetcher(target.origin + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: authKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: payload.password }), redirect: 'manual', signal: AbortSignal.timeout(20000) });
  } catch { fail('ارتباط با سرویس ورود برقرار نشد.', 502, 'AUTH_UNAVAILABLE'); }
  const result = await authResponseJSON(response);
  if (response.status === 429) fail('تعداد تلاش‌های ورود زیاد است؛ کمی بعد تلاش کنید.', 429, 'RATE_LIMITED');
  if (response.status >= 500) fail('سرویس ورود موقتاً در دسترس نیست.', 503, 'AUTH_UNAVAILABLE');
  if (!response.ok || !profile || user?.deletedAt || result.user?.id !== profile.auth_user_id || typeof result.access_token !== 'string' || typeof result.refresh_token !== 'string') fail('شماره تماس یا رمز عبور درست نیست.', 401, 'INVALID_CREDENTIALS');
  await verifySessionSecurity(repo, user.id, profile.auth_user_id, result.access_token);
  return { access_token: result.access_token, refresh_token: result.refresh_token, expires_in: result.expires_in };
}

function findIdentityUser(state, identity) {
  return state?.users.find(user => {
    try {
      if (identity.phone) return user.phone && normalizePhone(user.phone) === identity.phone;
      if (identity.username) return user.username && normalizeUsername(user.username) === identity.username;
      return user.email?.toLowerCase() === identity.email;
    } catch { return false; }
  });
}

/** getUser has already verified the JWT; only its server-issued session id is read here. */
async function verifySessionSecurity(repo, domainUserId, authUserId, accessToken) {
  const security = await repo.getSetting?.(`auth-security:${domainUserId}`);
  if (!security) return;
  if (security.blocked && (!security.blockUntil || security.blockUntil > Date.now())) fail('نشست معتبر نیست؛ برای بازیابی حساب با مدیر هماهنگ کنید.', 401, 'INVALID_SESSION');
  if (!security.validAfter) return;
  let sessionId;
  try {
    const part = accessToken.split('.')[1];
    const decoded = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    sessionId = decoded.session_id;
  } catch {}
  if (typeof sessionId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(sessionId) || !await repo.authSessionValid(authUserId, sessionId, security.validAfter)) fail('نشست منقضی شده است؛ دوباره وارد شوید.', 401, 'INVALID_SESSION');
}

async function withPrivateLock(repo, name, callback) {
  const token = crypto.randomUUID();
  const leaseMs = name.startsWith('account-security:') ? 300000 : 30000;
  if (!await repo.acquireLock(name, token, leaseMs)) fail('درخواست مشابه در حال انجام است؛ کمی بعد دوباره تلاش کنید.', 409, 'REQUEST_IN_PROGRESS');
  try { return await callback(); }
  finally { await repo.releaseLock(name, token).catch(() => {}); }
}

/** Add an explicitly requested login to an existing record, preserving its id. */
export async function activateAccount(client, repo, actor, payload) {
  manager(actor);
  await rate(repo, `account-activate:${actor.id}`, 10);
  const id = text(payload.id, 'شناسه حساب', 120), password = passwordValue(payload.password);
  let phone;
  try { phone = normalizePhone(payload.phone); }
  catch { fail('برای فعال‌سازی ورود، شماره تماس معتبر وارد کنید.', 400, 'INVALID_PHONE'); }
  return withPrivateLock(repo, `account-security:${id}`, async () => {
    const candidate = async loaded => {
      if (!loaded) fail('فضای کار آماده نیست.', 503, 'STATE_NOT_INITIALIZED');
      const current = loaded.state.users.find(person => person.id === id);
      if (!current || current.deletedAt) fail('پروندهٔ فعال یافت نشد.', 404, 'NOT_FOUND');
      if (current.role === 'manager') fail('فعال‌سازی مدیر از این مسیر مجاز نیست.', 403, 'MANAGER_ROLE_PROTECTED');
      if (await repo.getProfileByDomainId(id)) fail('ورود این حساب قبلاً فعال است؛ برای تغییر رمز از بازنشانی رمز استفاده کنید.', 409, 'ACCOUNT_ALREADY_ACTIVE');
      const state = structuredClone(loaded.state);
      const projects = state.projects;
      const user = applyAction(state, actor.id, 'account.update', {
        id, phone, ...(payload.username === undefined ? {} : { username: payload.username }),
      });
      // Activation validates identity fields using the normal account rules,
      // but must not reinterpret historical project assignments or roles.
      state.projects = projects;
      return { state, user };
    };
    let loaded = await repo.loadState();
    const preview = await candidate(loaded);
    // A legacy contact email is not proof of ownership of an existing Auth
    // identity. Create a fresh private alias rather than taking over that email.
    const authUser = await createAuthUser(client, {
      email: `account.${crypto.randomUUID()}@phone.arios.invalid`,
      name: preview.user.name, phone: preview.user.phone, password,
    });
    let commitUncertain = false;
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        if (attempt) loaded = await repo.loadState();
        const next = await candidate(loaded);
        next.state.audit.push({ id: crypto.randomUUID(), actorId: actor.id, action: 'account.activate', entityId: id, createdAt: new Date().toISOString(), description: 'ورود پروندهٔ موجود بدون تغییر سوابق فعال شد.' });
        commitUncertain = true;
        const committed = await repo.commitAccount({ expectedRevision: loaded.revision, state: next.state, authUserId: authUser.id, domainUserId: id, role: next.user.role });
        if (typeof committed !== 'boolean') fail('پاسخ فعال‌سازی ورود قطعی نیست؛ وضعیت اتصال باید دوباره بررسی شود.', 503, 'ACCOUNT_SETUP_PENDING');
        commitUncertain = false;
        if (committed) return { result: { ...safeUser(next.user), loginEnabled: true }, state: next.state };
      }
      fail('اطلاعات هم‌زمان تغییر کرد؛ دوباره تلاش کنید.', 409, 'STATE_CONFLICT');
    } catch (error) {
      if (await recoverCreatedAccount(client, repo, authUser.id, id, { allowCleanup: !commitUncertain })) {
        const current = await repo.loadState(), user = current?.state.users.find(person => person.id === id);
        if (!user) fail('نتیجهٔ فعال‌سازی ورود نیازمند بررسی است؛ دوباره تلاش کنید.', 503, 'ACCOUNT_SETUP_PENDING');
        return { result: { ...safeUser(user), loginEnabled: true }, state: current.state };
      }
      throw error;
    }
  });
}

async function accountStatus(client, repo, actor, payload, action) {
  manager(actor);
  await rate(repo, `${action}:${actor.id}`, 20);
  const id = text(payload.id, 'شناسه حساب', 120);
  return withPrivateLock(repo, `account-security:${id}`, async () => {
    const preview = await repo.loadState();
    if (!preview) fail('فضای کار آماده نیست.', 503, 'STATE_NOT_INITIALIZED');
    applyAction(structuredClone(preview.state), actor.id, action, { id });
    let authSecurity = Boolean(await repo.getProfileByDomainId(id));
    // A bounded block denies old sessions even if the database reply becomes uncertain.
    if (authSecurity) await repo.setSetting(`auth-security:${id}`, { blocked: true, blockUntil: Date.now() + 90000, validAfter: new Date().toISOString() });
    let changed;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const loaded = await repo.loadState();
      if (!loaded) fail('فضای کار آماده نیست.', 503, 'STATE_NOT_INITIALIZED');
      const state = structuredClone(loaded.state);
      const result = applyAction(state, actor.id, action, { id });
      const profile = await repo.getProfileByDomainId(result.id);
      if (profile && !authSecurity) {
        await repo.setSetting(`auth-security:${id}`, { blocked: true, blockUntil: Date.now() + 90000, validAfter: new Date().toISOString() });
        authSecurity = true;
      }
      if (await repo.updateAccount({ expectedRevision: loaded.revision, state, authUserId: profile?.auth_user_id ?? null, domainUserId: result.id, role: result.role })) { changed = { result: { ...safeUser(result), loginEnabled: Boolean(profile) }, state }; break; }
    }
    if (!changed) fail('اطلاعات هم‌زمان تغییر کرد؛ دوباره تلاش کنید.', 409, 'STATE_CONFLICT');
    if (authSecurity) await repo.setSetting(`auth-security:${id}`, { blocked: action === 'account.archive', validAfter: new Date().toISOString() });
    return changed;
  });
}
export const archiveAccount = (client, repo, actor, payload) => accountStatus(client, repo, actor, payload, 'account.archive');
export const restoreAccount = (client, repo, actor, payload) => accountStatus(client, repo, actor, payload, 'account.restore');

const RESET_REQUESTS = 'password-reset-requests';
const recoveryMessage = 'درخواست ثبت شد؛ برای بازیابی رمز با مدیر آریوس هماهنگ کنید.';
export async function requestPasswordReset(repo, payload) {
  const identity = loginIdentity(payload), identifier = Object.values(identity)[0];
  await rate(repo, 'password-reset-request:global', 30);
  await rate(repo, `password-reset-request:${await sha256(identifier)}`, 3, 3600000);
  const loaded = await repo.loadState(), user = findIdentityUser(loaded?.state, identity);
  // Unknown identifiers get the same acknowledgement, without filling the private
  // manager queue or evicting genuine account requests.
  if (!user || user.deletedAt) return { ok: true, message: recoveryMessage };
  await withPrivateLock(repo, RESET_REQUESTS, async () => {
    const saved = await repo.getSetting(RESET_REQUESTS), requests = Array.isArray(saved) ? saved.slice(-99) : [];
    if (!requests.some(item => item.status === 'pending' && item.userId === user.id)) {
      requests.push({ id: crypto.randomUUID(), userId: user.id, identifier, createdAt: new Date().toISOString(), status: 'pending' });
      await repo.setSetting(RESET_REQUESTS, requests.slice(-100));
    }
  });
  return { ok: true, message: recoveryMessage };
}
export async function listPasswordResetRequests(repo, actor) {
  manager(actor);
  await rate(repo, `password-reset-list:${actor.id}`, 60);
  const saved = await repo.getSetting(RESET_REQUESTS), loaded = await repo.loadState();
  const activeIds = new Set((loaded?.state?.users || []).filter(user => !user.deletedAt).map(user => user.id));
  return { requests: (Array.isArray(saved) ? saved : []).filter(item => item.status === 'pending' && activeIds.has(item.userId)).slice(-100).reverse() };
}

export async function resetAccountPassword(client, repo, actor, payload) {
  manager(actor);
  await rate(repo, `password-reset:${actor.id}`, 10);
  const id = text(payload.id, 'شناسه حساب', 120), password = passwordValue(payload.password);
  return withPrivateLock(repo, `account-security:${id}`, async () => {
    const loaded = await repo.loadState(), user = loaded?.state.users.find(user => user.id === id);
    if (!user || user.deletedAt) fail('حساب فعال یافت نشد.', 404, 'NOT_FOUND');
    if (user.role === 'manager') fail('رمز حساب مدیر از این مسیر تغییر نمی‌کند.', 403, 'MANAGER_ROLE_PROTECTED');
    const profile = await repo.getProfileByDomainId(id);
    if (!profile) fail('این پرونده هنوز حساب ورود ندارد؛ ابتدا «فعال‌سازی ورود» را برای همان فرد انجام دهید.', 409, 'ACCOUNT_NEEDS_ACTIVATION');
    if (profile.role !== user.role) fail('نقش حساب ورود با پرونده هماهنگ نیست؛ اطلاعات و نقش همین حساب را یک‌بار ذخیره کنید و سپس رمز را بازنشانی کنید.', 409, 'ACCOUNT_PROFILE_MISMATCH');
    const securityKey = `auth-security:${id}`, previousSecurity = await repo.getSetting(securityKey);
    // Keep the block durable until the final cutoff is saved. A timed unblock
    // could otherwise admit a session created while the password was changing.
    // The owner-manager is protected above and can retry an interrupted reset.
    await repo.setSetting(securityKey, { blocked: true, validAfter: new Date().toISOString() });
    let response;
    try { response = await client.auth.admin.updateUserById(profile.auth_user_id, { password }); }
    catch {
      // The Auth server may still commit after a network exception. Keep the
      // account closed until its manager retries and observes a definite result.
      fail('پاسخ تغییر رمز قطعی نشد؛ مدیر باید دوباره رمز جدید تعیین کند تا دسترسی حساب باز شود.', 503, 'PASSWORD_RESET_PENDING');
    }
    if (response.error || !response.data?.user?.id) {
      if (previousSecurity) await repo.setSetting(securityKey, previousSecurity);
      else await repo.deleteSetting(securityKey);
      fail('تغییر رمز انجام نشد؛ مدیر باید دوباره تلاش کند.', 503, 'PASSWORD_RESET_FAILED');
    }
    // Refreshing an older Auth session cannot bypass this cutoff: session_id stays the same.
    await repo.setSetting(`auth-security:${id}`, { blocked: false, validAfter: new Date().toISOString() });
    await withPrivateLock(repo, RESET_REQUESTS, async () => {
      const requests = await repo.getSetting(RESET_REQUESTS);
      if (Array.isArray(requests)) await repo.setSetting(RESET_REQUESTS, requests.map(item => item.status === 'pending' && item.userId === id ? { ...item, status: 'resolved', resolvedAt: new Date().toISOString(), resolvedBy: actor.id } : item).slice(-100));
    });
    return { result: { id, ok: true, sessionsRevoked: true }, state: loaded.state };
  });
}
