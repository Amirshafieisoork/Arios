/** Authentication is resolved from Supabase Auth and private profiles only. */
export class APIError extends Error {
  constructor(message, status = 400, code = 'INVALID_INPUT') {
    super(message); this.name = 'APIError'; this.status = status; this.code = code;
  }
}
const fail = (message, status = 400, code = 'INVALID_INPUT') => { throw new APIError(message, status, code); };
export const safeUser = user => user ? Object.fromEntries(['id', 'name', 'email', 'role', 'department', 'skill'].filter(key => user[key] !== undefined).map(key => [key, user[key]])) : null;
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
  if (typeof value !== 'string' || value.length < 12 || value.length > 128) fail('رمز عبور باید بین ۱۲ و ۱۲۸ نویسه باشد.');
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
  if (!profile || !['manager', 'worker', 'customer'].includes(profile.role)) fail('این حساب به فضای کار آریوس دسترسی ندارد.', 403, 'NOT_A_MEMBER');
  const loaded = await repo.loadState();
  if (!loaded) fail('راه‌اندازی فضای کار هنوز کامل نشده است.', 503, 'STATE_NOT_INITIALIZED');
  const user = loaded.state.users.find(user => user.id === profile.domain_user_id);
  if (!user || user.role !== profile.role) fail('دسترسی حساب نیازمند بررسی مدیر است.', 403, 'PROFILE_MISMATCH');
  return { user, authUser: response.data.user, state: loaded.state, revision: loaded.revision };
}

export function emptyState(email) {
  return { schemaVersion: 1, users: [{ id: 'manager', name: 'مدیر آریوس', email, role: 'manager' }], projects: [], reports: [], materials: [], invoices: [], messages: [], tickets: [], inventory: [], receipts: [], audit: [] };
}

async function createAuthUser(client, { email, password, name }) {
  let response;
  try { response = await client.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name } }); }
  catch { fail('ساخت حساب فعلاً انجام نشد؛ دوباره تلاش کنید.', 502, 'AUTH_UNAVAILABLE'); }
  if (response.error || !response.data?.user?.id) {
    const duplicate = ['email_exists', 'user_already_exists'].includes(response.error?.code);
    fail(duplicate ? 'حسابی با این ایمیل وجود دارد.' : 'حساب ایجاد نشد؛ ایمیل و رمز را بررسی کنید.', duplicate ? 409 : 400, duplicate ? 'DUPLICATE_EMAIL' : 'AUTH_CREATE_FAILED');
  }
  return response.data.user;
}

/** Never delete an Auth user after an uncertain database commit. */
async function recoverCreatedAccount(client, repo, authUserId, domainUserId) {
  let profile;
  try { profile = await repo.getProfile(authUserId); }
  catch { fail('وضعیت ساخت حساب هنوز قطعی نیست؛ مدیر باید اتصال حساب را بررسی کند.', 503, 'ACCOUNT_SETUP_PENDING'); }
  if (profile) {
    if (profile.domain_user_id !== domainUserId) fail('اتصال حساب نیازمند بررسی مدیر است.', 503, 'ACCOUNT_SETUP_PENDING');
    return true;
  }
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
  try {
    if (!await repo.bootstrap({ authUserId: authUser.id, state, codeHash })) fail('راه‌اندازی حساب کامل نشد؛ دوباره تلاش کنید.', 409, 'BOOTSTRAP_CONFLICT');
  } catch (error) {
    if (!await recoverCreatedAccount(client, repo, authUser.id, owner.id)) throw error;
  }
  return { ok: true, user: safeUser(owner) };
}

function accountInState(state, actorId, payload, domainUserId) {
  manager(state.users.find(user => user.id === actorId));
  const name = text(payload.name, 'نام', 120), email = emailValue(payload.email);
  if (!['worker', 'customer'].includes(payload.role)) fail('نقش حساب معتبر نیست.');
  if (state.users.some(user => user.email?.toLowerCase() === email)) fail('این ایمیل قبلاً در فضای کار ثبت شده است.', 409, 'DUPLICATE_EMAIL');
  const projectIds = payload.projectIds ?? [];
  if (!Array.isArray(projectIds) || projectIds.length > 100 || projectIds.some(id => typeof id !== 'string' || !id || id.length > 120) || new Set(projectIds).size !== projectIds.length) fail('فهرست پروژه‌ها معتبر نیست.');
  const projects = projectIds.map(id => state.projects.find(project => project.id === id));
  if (projects.some(project => !project)) fail('پروژه یافت نشد.', 404, 'NOT_FOUND');
  if (payload.role === 'customer' && projects.some(project => project.customerId)) fail('پروژه از قبل مشتری دارد.', 409, 'PROJECT_OWNED');
  const user = { id: domainUserId, name, email, role: payload.role, ...(payload.role === 'worker' ? { hourlyRate: 0, rateHistory: [] } : {}) };
  state.users.push(user);
  for (const project of projects) {
    if (user.role === 'customer') project.customerId = user.id;
    else project.memberIds = [...new Set([...(project.memberIds || []), user.id])];
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
  const authUser = await createAuthUser(client, { email: candidate.email, name: candidate.name, password });
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = attempt === 0 ? loaded : await repo.loadState();
      if (!current) fail('فضای کار آماده نیست.', 503, 'STATE_NOT_INITIALIZED');
      const state = structuredClone(current.state);
      const user = accountInState(state, actor.id, payload, domainUserId);
      if (await repo.commitAccount({ expectedRevision: current.revision, state, authUserId: authUser.id, domainUserId, role: user.role })) return { result: safeUser(user), state };
    }
    fail('اطلاعات هم‌زمان تغییر کرد؛ دوباره تلاش کنید.', 409, 'STATE_CONFLICT');
  } catch (error) {
    if (await recoverCreatedAccount(client, repo, authUser.id, domainUserId)) {
      const current = await repo.loadState();
      if (!current) fail('وضعیت ساخت حساب نیازمند بررسی است.', 503, 'ACCOUNT_SETUP_PENDING');
      return { result: safeUser(current.state.users.find(user => user.id === domainUserId)), state: current.state };
    }
    throw error;
  }
}
