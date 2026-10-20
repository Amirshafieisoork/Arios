import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, encryptSecret, decryptSecret } from '../worker/storage.mjs';
import { createTestD1 } from './helpers/d1.mjs';

test('D1 state survives fresh store instances and initialization never overwrites data', async t => {
  const db = createTestD1(); t.after(() => db.close());
  const store = createStore(db);
  assert.equal(await store.loadState(), null);
  await store.initState({ count: 1, records: [] });
  await store.initState({ count: 999 });
  const changed = await store.mutateState(state => { state.count += 1; state.records.push('گزارش'); return { saved: true }; });
  assert.deepEqual(changed.result, { saved: true });
  assert.equal(changed.state.count, 2);
  assert.deepEqual(await createStore(db).loadState(), { state: { count: 2, records: ['گزارش'] }, revision: 1 });
  await store.setSetting('integrations', 'ciphertext');
  await store.setSetting('integrations', 'new-ciphertext');
  assert.equal(await createStore(db).getSetting('integrations'), 'new-ciphertext');
  assert.equal(await store.getSetting('missing'), null);
});

test('concurrent state writers retry CAS instead of losing a report', async t => {
  const db = createTestD1(); t.after(() => db.close());
  const a = createStore(db), b = createStore(db);
  await a.initState({ reports: [] });
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const slow = a.mutateState(async state => { calls += 1; if (calls === 1) { entered(); await gate; } state.reports.push('slow'); return 'slow'; });
  await started;
  await b.mutateState(state => { state.reports.push('fast'); });
  release();
  await slow;
  const result = await a.loadState();
  assert.equal(calls, 2);
  assert.deepEqual(result.state.reports, ['fast', 'slow']);
  assert.equal(result.revision, 2);
});

test('failed domain validation leaves persisted state untouched', async t => {
  const db = createTestD1(); t.after(() => db.close());
  const store = createStore(db); await store.initState({ reports: [] });
  await assert.rejects(store.mutateState(state => { state.reports.push('invalid'); throw new Error('invalid report'); }), /invalid report/);
  assert.deepEqual((await store.loadState()).state, { reports: [] });
});

test('schema enforces a single state row and one Telegram account per ARIOS user', async t => {
  const db = createTestD1(); t.after(() => db.close());
  const store = createStore(db);
  await assert.rejects(store.run('INSERT INTO arios_state (id,data) VALUES (?,?)', 2, '{}'), /CHECK constraint/);
  await store.run('INSERT INTO arios_telegram_links VALUES (?,?,?,?)', '42', 'worker', '42', '2026-10-20');
  await assert.rejects(store.run('INSERT INTO arios_telegram_links VALUES (?,?,?,?)', '43', 'worker', '43', '2026-10-20'), /UNIQUE constraint/);
});

test('AES-GCM keeps settings confidential and detects tampering or a wrong key', async () => {
  const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  const otherKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  const secret = JSON.stringify({ telegramBotToken: 'test-only-sensitive-value', label: 'آریوس' });
  const first = await encryptSecret(secret, key), second = await encryptSecret(secret, key);
  assert.notEqual(first, second);
  assert.ok(!first.includes('test-only-sensitive-value'));
  assert.equal(await decryptSecret(first, key), secret);
  await assert.rejects(decryptSecret(first, otherKey), { code: 'SETTINGS_DECRYPT_FAILED' });
  const parts = first.split(':');
  const bytes = Uint8Array.from(atob(parts[2]), char => char.charCodeAt(0)); bytes[0] ^= 1;
  parts[2] = btoa(String.fromCharCode(...bytes));
  await assert.rejects(decryptSecret(parts.join(':'), key), { code: 'SETTINGS_DECRYPT_FAILED' });
  await assert.rejects(encryptSecret(secret, 'bad'), { code: 'ENCRYPTION_NOT_CONFIGURED' });
  await assert.rejects(decryptSecret('v2:bad:data', key), { code: 'SETTINGS_DECRYPT_FAILED' });
});
