/** ARIOS-only D1 persistence. All schema changes are applied by versioned migrations. */
export class StorageError extends Error {
  constructor(message, status = 503, code = 'STORAGE_UNAVAILABLE') {
    super(message); this.name = 'StorageError'; this.status = status; this.code = code;
  }
}

export function createStore(db) {
  if (!db || typeof db.prepare !== 'function') throw new StorageError('ذخیره‌سازی آریوس در دسترس نیست.');
  const statement = (sql, values) => db.prepare(sql).bind(...values);
  const run = (sql, ...values) => statement(sql, values).run();
  const first = (sql, ...values) => statement(sql, values).first();
  const query = async (sql, ...values) => (await statement(sql, values).all()).results || [];
  const loadState = async () => {
    const row = await first('SELECT data, revision FROM arios_state WHERE id = 1');
    if (!row) return null;
    let state;
    try { state = JSON.parse(row.data); }
    catch { throw new StorageError('اطلاعات ذخیره‌شدهٔ آریوس قابل خواندن نیست.', 500, 'INVALID_STATE'); }
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new StorageError('ساختار اطلاعات آریوس معتبر نیست.', 500, 'INVALID_STATE');
    return { state, revision: row.revision };
  };
  const initState = async state => {
    await run('INSERT OR IGNORE INTO arios_state (id, data, revision) VALUES (1, ?, 0)', JSON.stringify(state));
    return loadState();
  };
  // The callback may run again after a concurrent write; keep it free of external side effects.
  const mutateState = async callback => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const loaded = await loadState();
      if (!loaded) throw new StorageError('فضای کار آریوس هنوز آماده نشده است.', 503, 'STATE_NOT_INITIALIZED');
      const state = structuredClone(loaded.state);
      const result = await callback(state);
      const written = await run('UPDATE arios_state SET data = ?, revision = revision + 1 WHERE id = 1 AND revision = ?', JSON.stringify(state), loaded.revision);
      if (Number(written.meta?.changes) === 1) return { result, state };
    }
    throw new StorageError('اطلاعات هم‌زمان تغییر کرد؛ دوباره تلاش کنید.', 409, 'STATE_CONFLICT');
  };
  const getSetting = async key => (await first('SELECT value FROM arios_settings WHERE key = ?', key))?.value ?? null;
  const setSetting = async (key, value) => {
    if (typeof key !== 'string' || !key || typeof value !== 'string') throw new TypeError('Settings require string keys and values.');
    await run('INSERT INTO arios_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  };
  return { db, query, first, run, loadState, initState, mutateState, getSetting, setSetting };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const context = encoder.encode('arios:settings:v1');
const toBase64 = bytes => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const fromBase64 = value => {
  if (typeof value !== 'string' || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid base64.');
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
};
async function encryptionKey(base64Key) {
  try {
    const bytes = fromBase64(base64Key);
    if (bytes.length !== 32) throw new Error('Invalid key size.');
    return await crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  } catch {
    throw new StorageError('کلید امن تنظیمات آریوس پیکربندی نشده است.', 503, 'ENCRYPTION_NOT_CONFIGURED');
  }
}
export async function encryptSecret(value, base64Key) {
  if (typeof value !== 'string') throw new TypeError('Secret value must be a string.');
  const key = await encryptionKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: context, tagLength: 128 }, key, encoder.encode(value)));
  return `v1:${toBase64(iv)}:${toBase64(ciphertext)}`;
}
export async function decryptSecret(value, base64Key) {
  const key = await encryptionKey(base64Key);
  try {
    if (typeof value !== 'string') throw new Error('Invalid encrypted setting.');
    const parts = value.split(':');
    if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('Unsupported encrypted setting.');
    const iv = fromBase64(parts[1]);
    const ciphertext = fromBase64(parts[2]);
    if (iv.length !== 12 || ciphertext.length < 16) throw new Error('Invalid encrypted setting.');
    return decoder.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: context, tagLength: 128 }, key, ciphertext));
  } catch {
    throw new StorageError('تنظیمات امن آریوس قابل بازیابی نیست؛ اتصال را دوباره تنظیم کنید.', 503, 'SETTINGS_DECRYPT_FAILED');
  }
}
