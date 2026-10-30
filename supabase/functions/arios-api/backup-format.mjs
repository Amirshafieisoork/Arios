/** Portable, authenticated backup parts. No provider key belongs in this format. */
export const BACKUP_FORMAT = 'arios-backup/v1';
export const BACKUP_CHUNK_BYTES = 16 * 1024 * 1024;
const encoder = new TextEncoder();
const magic = encoder.encode('ARIOSBK1');
export const hex = bytes => Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
export const sha256 = async bytes => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
export const keyBytes = key => {
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) throw new Error('BACKUP_KEY_INVALID');
  return Uint8Array.from(key.match(/../g), v => parseInt(v, 16));
};
export async function encryptBackupPart(bytes, key, backupId, itemId) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const imported = await crypto.subtle.importKey('raw', keyBytes(key), 'AES-GCM', false, ['encrypt']);
  const body = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(`${BACKUP_FORMAT}:${backupId}:${itemId}`)}, imported, bytes));
  const output = new Uint8Array(20 + body.byteLength); output.set(magic); output.set(iv,8); output.set(body,20);
  return output;
}
export async function decryptBackupPart(bytes, key, backupId, itemId) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 36 || !magic.every((n,i)=>bytes[i]===n)) throw new Error('BACKUP_PART_INVALID');
  const imported = await crypto.subtle.importKey('raw', keyBytes(key), 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.slice(8,20),additionalData:encoder.encode(`${BACKUP_FORMAT}:${backupId}:${itemId}`)}, imported, bytes.slice(20)));
}
export function safeBackupName(name) {
  return typeof name==='string' && name.length>0 && name.length<=1200 && !name.startsWith('/') && !name.includes('\\') && !/[\u0000-\u001f\u007f]/.test(name) && name.split('/').every(part=>part && part!=='.' && part!=='..');
}
/** Credentials cannot escape through legacy test records or nested audit payloads. */
export function redactBackupSecrets(value) {
  const blocked = /^(?:password|passwordHash|password_hash|encrypted_password|access_token|refresh_token|service_role|serviceRoleKey|secretKey|aiApiKey|telegramBotToken|codeHash|tokenHash)$/i;
  if (Array.isArray(value)) return value.map(redactBackupSecrets);
  if (value && typeof value==='object') return Object.fromEntries(Object.entries(value).filter(([key])=>!blocked.test(key)).map(([key,item])=>[key,redactBackupSecrets(item)]));
  return value;
}
export function weeklyBackupSlot(at=Date.now()) {
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tehran',calendar:'gregory',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(at)).map(p=>[p.type,p.value]));
  const localDate=`${parts.year}-${parts.month}-${parts.day}`, day=new Date(`${localDate}T12:00:00Z`), sinceSaturday=(day.getUTCDay()+1)%7;
  day.setUTCDate(day.getUTCDate()-sinceSaturday);
  let date=day.toISOString().slice(0,10), dueAt=Date.parse(date+'T21:15:00+03:30');
  if(dueAt>at){day.setUTCDate(day.getUTCDate()-7);date=day.toISOString().slice(0,10);dueAt=Date.parse(date+'T21:15:00+03:30');}
  return {week:date,dueAt};
}
