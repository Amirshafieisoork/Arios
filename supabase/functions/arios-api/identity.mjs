/** Shared phone formatting. Authorization always comes from private server profiles. */
export class IdentityError extends Error {
  constructor(message = 'شماره تماس معتبر نیست.') { super(message); this.name = 'IdentityError'; this.status = 400; this.code = 'INVALID_PHONE'; }
}
export const latinDigits = value => String(value).replace(/[۰-۹٠-٩]/g, character => String('۰۱۲۳۴۵۶۷۸۹'.includes(character) ? '۰۱۲۳۴۵۶۷۸۹'.indexOf(character) : '٠١٢٣٤٥٦٧٨٩'.indexOf(character)));
export function normalizePhone(value) {
  if (typeof value !== 'string' || value.length > 80) throw new IdentityError();
  let phone = latinDigits(value).trim().replace(/[\s()\-\u200c\u200e\u200f]/g, '');
  if (phone.startsWith('0098')) phone = '+98' + phone.slice(4);
  else if (phone.startsWith('00')) phone = '+' + phone.slice(2);
  else if (/^0\d{10}$/.test(phone)) phone = '+98' + phone.slice(1);
  else if (/^98\d{10}$/.test(phone)) phone = '+' + phone;
  else if (/^9\d{9}$/.test(phone)) phone = '+98' + phone;
  if (!/^\+[1-9]\d{6,14}$/.test(phone) || (/^\+98/.test(phone) && !/^\+98[1-9]\d{9}$/.test(phone))) throw new IdentityError();
  return phone;
}
export function normalizeUsername(value) {
  if (typeof value !== 'string') throw new IdentityError('نام کاربری معتبر نیست.');
  const username = latinDigits(value).normalize('NFKC').trim().toLowerCase();
  if (!/^[\p{L}][\p{L}\p{N}_.-]{2,39}$/u.test(username)) throw new IdentityError('نام کاربری باید ۳ تا ۴۰ نویسه و شامل حروف، عدد، نقطه، خط تیره یا زیرخط باشد.');
  return username;
}
export const phoneAuthEmail = phone => `phone.${normalizePhone(phone).slice(1)}@phone.arios.invalid`;
export const internalAuthEmail = value => typeof value === 'string' && /@phone\.arios\.invalid$/i.test(value);
export function loginIdentity(payload) {
  const supplied = payload?.identifier ?? payload?.phone ?? payload?.username ?? payload?.email;
  if (typeof supplied !== 'string' || !supplied.trim() || supplied.length > 254) throw new IdentityError('شماره تماس، نام کاربری یا ایمیل معتبر نیست.');
  const identifier = supplied.trim();
  if (identifier.includes('@')) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier) || internalAuthEmail(identifier)) throw new IdentityError('شماره تماس، نام کاربری یا ایمیل معتبر نیست.');
    return { email: identifier.toLowerCase() };
  }
  return /^[+\d۰-۹٠-٩(]/u.test(identifier) ? { phone: normalizePhone(identifier) } : { username: normalizeUsername(identifier) };
}
