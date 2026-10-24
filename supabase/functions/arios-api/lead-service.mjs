import { APIError, manager, rate, sha256 } from './auth.mjs';
import { normalizePhone } from './identity.mjs';

const fail = (message, status = 400, code = 'INVALID_INPUT') => { throw new APIError(message, status, code); };
const optionalText = (value, max, label) => {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(`${label} معتبر نیست.`);
  return value.trim();
};
const receipt = (row, created = false) => ({
  accepted: true,
  lead: { id: row.id, status: row.status, createdAt: row.created_at },
  message: 'شماره شما ثبت شد؛ تیم آریوس برای پیگیری با شما تماس می‌گیرد.',
  created,
});
const record = row => ({ id: row.id, name: row.name, phone: row.phone, message: row.message, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at });
const sameRequest = (row, hash) => {
  if (row.request_hash !== hash) fail('این شناسه برای درخواست دیگری استفاده شده است؛ درخواست تازه بسازید.', 409, 'REQUEST_ID_CONFLICT');
  return row;
};

/** A callback receipt exists only after the private database has acknowledged it. */
export async function createPublicLead({ repo, payload }) {
  if (payload.consent !== true) fail('برای درخواست تماس، موافقت خود با ارسال شماره به تیم آریوس را اعلام کنید.', 400, 'CONSENT_REQUIRED');
  if (typeof payload.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.requestId)) fail('شناسهٔ درخواست معتبر نیست.', 400, 'REQUEST_ID_INVALID');
  let phone;
  try { phone = normalizePhone(payload.phone); }
  catch { fail('شماره تماس معتبر نیست.', 400, 'PHONE_INVALID'); }
  const name = optionalText(payload.name, 120, 'نام'), message = optionalText(payload.message, 1200, 'شرح درخواست');
  const requestId = payload.requestId.toLowerCase(), requestHash = await sha256(JSON.stringify([phone, name, message]));
  const previous = await repo.findLeadRequest(requestId);
  if (previous) return receipt(sameRequest(previous, requestHash));
  await rate(repo, 'public-leads-minute', 20);
  await rate(repo, 'public-leads-day', 200, 86400000);
  const bucket = typeof payload.clientId === 'string' && /^[a-f0-9]{64}$/.test(payload.clientId) ? payload.clientId.slice(0, 6) : 'direct';
  await rate(repo, `public-leads-visitor:${bucket}`, 3, 3600000);
  await rate(repo, `public-leads-phone:${await sha256(phone)}`, 3, 86400000);
  const saved = await repo.createLead({ requestId, requestHash, phone, name, message });
  if (!saved?.lead?.id) fail('ثبت درخواست تماس تأیید نشد؛ دوباره تلاش کنید.', 503, 'LEAD_NOT_SAVED');
  return receipt(sameRequest(saved.lead, requestHash), saved.created);
}

export async function listLeads({ repo, user }) {
  manager(user);
  return { leads: (await repo.listLeads()).map(record) };
}

export async function updateLeadStatus({ repo, user, id, payload }) {
  manager(user);
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) fail('درخواست تماس پیدا نشد.', 404, 'LEAD_NOT_FOUND');
  if (!['new', 'contacted', 'closed'].includes(payload.status)) fail('وضعیت درخواست معتبر نیست.', 400, 'LEAD_STATUS_INVALID');
  const lead = await repo.updateLeadStatus(id, payload.status);
  if (!lead) fail('درخواست تماس پیدا نشد.', 404, 'LEAD_NOT_FOUND');
  return { lead: record(lead) };
}
