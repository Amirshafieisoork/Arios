/** Typed application repository. Requires a server-only Supabase service-role client. */
export class RepositoryError extends Error {
  constructor(message = 'ذخیره‌سازی آریوس در دسترس نیست.', status = 503, code = 'STORAGE_UNAVAILABLE') {
    super(message); this.name = 'RepositoryError'; this.status = status; this.code = code;
  }
}

const now = () => new Date().toISOString();
const boundedLimit = (limit, max = 100) => Math.max(1, Math.min(max, Number.isSafeInteger(limit) ? limit : max));
const draftColumns = 'id,user_id,source,status,transcript,fields,source_metadata,storage_path,error,report_id,file_id,created_at,updated_at,claim,claim_until';
const linkColumns = 'telegram_user_id,user_id,chat_id,created_at';
const profileColumns = 'auth_user_id,domain_user_id,role,created_at';
const leadColumns = 'id,request_id,request_hash,name,phone,message,status,created_at,updated_at';
function databaseFailure(error) {
  if (error?.code === '23505') return new RepositoryError('این حساب یا رکورد قبلاً ثبت یا متصل شده است.', 409, 'DUPLICATE_RECORD');
  if (error?.code === '23503') return new RepositoryError('حساب مرتبط یافت نشد.', 409, 'RELATED_ACCOUNT_MISSING');
  if (error?.code === '22023' || error?.code === '23514') return new RepositoryError('ساختار اطلاعات معتبر نیست.', 400, 'INVALID_DATA');
  return new RepositoryError();
}

export function createRepository(client) {
  if (!client?.from || !client?.rpc) throw new TypeError('A server-side Supabase client is required.');
  const result = async request => {
    let response;
    try { response = await request; }
    catch { throw new RepositoryError(); }
    if (response.error) throw databaseFailure(response.error);
    return response.data;
  };
  const rpc = (name, parameters) => result(client.rpc(name, parameters));
  const loadState = async () => {
    const row = await result(client.from('arios_state').select('data,revision').eq('id', 1).maybeSingle());
    return row ? { state: row.data, revision: Number(row.revision) } : null;
  };
  const initState = async state => {
    await result(client.from('arios_state').upsert({ id: 1, data: state, revision: 0 }, { onConflict: 'id', ignoreDuplicates: true }));
    return loadState();
  };
  // Callback can be repeated on conflicts; perform external calls before this transaction.
  const mutateState = async callback => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const row = await loadState();
      if (!row) throw new RepositoryError('فضای کار آریوس هنوز راه‌اندازی نشده است.', 503, 'STATE_NOT_INITIALIZED');
      const state = structuredClone(row.state);
      const callbackResult = await callback(state);
      const changed = await rpc('arios_state_cas', { p_expected_revision: row.revision, p_data: state });
      if (changed === true) return { result: callbackResult, state };
    }
    throw new RepositoryError('اطلاعات هم‌زمان تغییر کرد؛ دوباره تلاش کنید.', 409, 'STATE_CONFLICT');
  };
  const getSetting = async key => (await result(client.from('arios_settings').select('value').eq('key', key).maybeSingle()))?.value ?? null;
  const setSetting = async (key, value) => { await result(client.from('arios_settings').upsert({ key, value }, { onConflict: 'key' })); };
  const deleteSetting = async key => { await result(client.from('arios_settings').delete().eq('key', key)); };
  const getProfile = authUserId => result(client.from('arios_profiles').select(profileColumns).eq('auth_user_id', authUserId).maybeSingle());
  const getProfileByDomainId = domainUserId => result(client.from('arios_profiles').select(profileColumns).eq('domain_user_id', domainUserId).maybeSingle());
  const listProfileLinks = async () => {
    const links = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await result(client.from('arios_profiles').select('domain_user_id,role').order('domain_user_id').range(offset, offset + 999));
      links.push(...(page || []));
      if (!page || page.length < 1000) return links;
    }
  };
  const createProfile = ({ authUserId, domainUserId, role }) => result(client.from('arios_profiles').insert({ auth_user_id: authUserId, domain_user_id: domainUserId, role }).select(profileColumns).single());
  const bootstrap = ({ authUserId, state, codeHash }) => rpc('arios_bootstrap', { p_auth_user_id: authUserId, p_state: state, p_code_hash: codeHash });
  const commitAccount = ({ expectedRevision, state, authUserId, domainUserId, role }) => rpc('arios_account_commit', { p_expected_revision: expectedRevision, p_state: state, p_auth_user_id: authUserId, p_domain_user_id: domainUserId, p_role: role });
  const authSessionValid = (authUserId, sessionId, validAfter) => rpc('arios_auth_session_valid', { p_auth_user_id: authUserId, p_session_id: sessionId, p_valid_after: validAfter });
  const updateAccount = ({ expectedRevision, state, authUserId, domainUserId, role }) => rpc('arios_account_update', { p_expected_revision: expectedRevision, p_state: state, p_auth_user_id: authUserId, p_domain_user_id: domainUserId, p_role: role });

  const findLeadRequest = requestId => result(client.from('arios_leads').select(leadColumns).eq('request_id', requestId).maybeSingle());
  const createLead = async ({ requestId, requestHash, name, phone, message }) => {
    // The unique request key makes concurrent retries one insert; do not overwrite
    // contact details or a manager's status when an older browser retries.
    const rows = await result(client.from('arios_leads').upsert({ request_id: requestId, request_hash: requestHash, name, phone, message }, { onConflict: 'request_id', ignoreDuplicates: true }).select(leadColumns));
    const created = Boolean(rows?.length), lead = created ? rows[0] : await findLeadRequest(requestId);
    return { created, lead };
  };
  const listLeads = () => result(client.from('arios_leads').select(leadColumns).order('created_at', { ascending: false }).limit(100));
  const updateLeadStatus = (id, status) => result(client.from('arios_leads').update({ status, updated_at: now() }).eq('id', id).select(leadColumns).maybeSingle());

  const listDrafts = (userId = null, limit = 100) => {
    let query = client.from('arios_drafts').select(draftColumns).order('created_at', { ascending: false }).limit(boundedLimit(limit));
    if (userId) query = query.eq('user_id', userId);
    return result(query);
  };
  const getDraft = id => result(client.from('arios_drafts').select(draftColumns).eq('id', id).maybeSingle());
  const createDraft = ({ id, userId, source, status = 'pending', transcript = '', fields = {}, fileId = null, sourceMetadata = {}, storagePath = null, createdAt = now() }) => result(client.from('arios_drafts').insert({
    id, user_id: userId, source, status, transcript, fields, file_id: fileId,
    source_metadata: sourceMetadata, storage_path: storagePath, created_at: createdAt, updated_at: createdAt,
  }).select(draftColumns).single());
  const updateDraft = (id, patch, { claim } = {}) => {
    const allowed = ['status', 'transcript', 'fields', 'error', 'report_id', 'claim', 'claim_until', 'storage_path', 'source_metadata'];
    const data = Object.fromEntries(allowed.filter(key => patch[key] !== undefined).map(key => [key, patch[key]]));
    if (data.claim_until === null) data.claim_until = 0;
    data.updated_at = now();
    let query = client.from('arios_drafts').update(data).eq('id', id);
    if (claim !== undefined) query = query.eq('claim', claim);
    return result(query.select(draftColumns).maybeSingle());
  };
  const claimDraft = async (id, claim, leaseMs = 300000) => (await rpc('arios_draft_claim', { p_id: id, p_claim: claim, p_lease_ms: leaseMs }))?.[0] ?? null;
  const pendingTelegramDrafts = async (limit = 2) => {
    const rows = await result(client.from('arios_drafts').select(draftColumns).eq('source', 'telegram')
      .or(`status.eq.pending,and(status.eq.processing,claim_until.lt.${Date.now()})`)
      .order('created_at', { ascending: true }).limit(boundedLimit(limit, 10)));
    return rows || [];
  };
  const expiredUploadDrafts = (before, limit = 20) => result(client.from('arios_drafts').select(draftColumns).eq('source', 'upload').eq('transcript', '')
    .in('status', ['pending', 'failed']).lt('created_at', before).limit(boundedLimit(limit, 100)));
  const completedUploadDrafts = (before, limit = 20) => result(client.from('arios_drafts').select(draftColumns).eq('source', 'upload').neq('transcript', '')
    .not('storage_path', 'is', null).lt('created_at', before).limit(boundedLimit(limit, 100)));
  const expiredAudioDrafts = (before, limit = 40) => result(client.from('arios_drafts').select(draftColumns).in('source', ['upload', 'telegram'])
    .not('storage_path', 'is', null).lt('created_at', before)
    .or(`status.neq.processing,claim_until.lt.${Date.now()}`).limit(boundedLimit(limit, 100)));

  const listTelegramLinks = (userId = null) => {
    let query = client.from('arios_telegram_links').select(linkColumns);
    if (userId) query = query.eq('user_id', userId);
    return result(query);
  };
  const getTelegramLink = telegramUserId => result(client.from('arios_telegram_links').select(linkColumns).eq('telegram_user_id', String(telegramUserId)).maybeSingle());
  const createLinkCode = ({ codeHash, userId, expiresAt }) => rpc('arios_link_code_create', { p_code_hash: codeHash, p_user_id: userId, p_expires_at: expiresAt });
  const consumeLinkCode = async ({ codeHash, telegramUserId, chatId }) => (await rpc('arios_link_code_consume', { p_code_hash: codeHash, p_telegram_user_id: String(telegramUserId), p_chat_id: String(chatId) }))?.[0] ?? null;
  const unlinkTelegram = userId => rpc('arios_telegram_unlink', { p_user_id: userId });
  const ingestUpdates = updates => rpc('arios_updates_ingest', { p_updates: updates });
  const listPendingUpdates = (limit = 100) => result(client.from('arios_telegram_updates').select('update_id,payload,status,error,created_at').eq('status', 'pending').order('update_id', { ascending: true }).limit(boundedLimit(limit)));
  const setUpdateStatus = (updateId, status, error = null) => result(client.from('arios_telegram_updates').update({ status, error,
    ...(['processed', 'ignored'].includes(status) ? { payload: {} } : {}),
  }).eq('update_id', updateId));
  const hasTelegramHistory = async () => {
    const sets = await Promise.all([
      result(client.from('arios_telegram_links').select('telegram_user_id').limit(1)),
      result(client.from('arios_drafts').select('id').eq('source', 'telegram').limit(1)),
      result(client.from('arios_telegram_updates').select('update_id').limit(1)),
    ]);
    return sets.some(rows => rows?.length);
  };

  const acquireLock = (name, token, leaseMs = 300000) => rpc('arios_lock_acquire', { p_name: name, p_token: token, p_lease_ms: leaseMs });
  const releaseLock = (name, token) => rpc('arios_lock_release', { p_name: name, p_token: token });
  const rateLimit = (key, limit, windowMs = 60000) => rpc('arios_rate_limit', { p_key: key, p_limit: limit, p_window_ms: windowMs });
  return {
    loadState, initState, mutateState, getSetting, setSetting, deleteSetting,
    getProfile, getProfileByDomainId, listProfileLinks, createProfile, bootstrap, commitAccount, updateAccount, authSessionValid,
    findLeadRequest, createLead, listLeads, updateLeadStatus,
    listDrafts, getDraft, createDraft, updateDraft, claimDraft, pendingTelegramDrafts, expiredUploadDrafts, completedUploadDrafts, expiredAudioDrafts,
    listTelegramLinks, getTelegramLink, createLinkCode, consumeLinkCode, unlinkTelegram,
    ingestUpdates, listPendingUpdates, setUpdateStatus, hasTelegramHistory,
    acquireLock, releaseLock, rateLimit,
  };
}
