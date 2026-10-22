import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeedState, publicState, applyAction } from '../public/domain.mjs';
import { renderInventoryWorkspace, wireInventoryWorkspace, openInventoryConsumption } from '../public/inventory-workspace.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const context = extra => ({ e: escape, n: String, money: value => `COST:${value}`, date: value => `DATE:${value}`, today: () => '2026-10-22', projectName: String, personName: String, ...extra });
function fixture() {
  const seed = createSeedState();
  seed.users.push({ id: 'warehouse', name: 'انباردار', username: 'warehouse-test', role: 'warehouse' });
  seed.users.push({ id: 'accountant', name: 'حسابدار', role: 'accountant' });
  return seed;
}
function useDocument(t, value) {
  const previous = globalThis.document; globalThis.document = value;
  t.after(() => previous === undefined ? delete globalThis.document : globalThis.document = previous);
}
function buttonFor(action, id) {
  const button = { dataset: { inventoryAction: action, inventoryId: id }, addEventListener: (_, listener) => { button.click = listener; } };
  return button;
}
function documentFor(button) { return { querySelector: () => null, querySelectorAll: selector => selector === '[data-inventory-action]' ? [button] : [] }; }
const data = object => { const form = new FormData(); for (const [key, value] of Object.entries(object)) form.set(key, value); return form; };

test('worker inventory shows assigned consumption and safe stock, with no prices or replenishment controls', () => {
  const seed = fixture(), worker = publicState(seed, 'worker');
  const html = renderInventoryWorkspace(worker, context());
  assert.match(html, /ثبت مصرف کالا/);
  assert.match(html, /برگشت کالا به انبار/);
  assert(!html.includes('COST:'));
  assert(!html.includes('data-inventory-action="create"'));
  assert(!html.includes('data-inventory-action="receive"'));
  assert(!html.includes('همایش ایده‌پرداز'));
  assert(!html.includes('کمپین رسانه‌ای یارا'));
  assert(!html.includes('name="unitPrice"'));
  assert.match(renderInventoryWorkspace(publicState(seed, 'customer'), context()), /برای نقش شما در دسترس نیست/);
  assert.match(renderInventoryWorkspace(publicState(seed, 'accountant'), context()), /برای نقش شما در دسترس نیست/);
});

test('scoped project view cannot fall through to another project or global stock', () => {
  const state = publicState(fixture(), 'worker');
  const project = renderInventoryWorkspace(state, context({ inventoryProjectId: 'p1' }));
  assert(project.includes('کابل شبکه Cat6'));
  assert(!project.includes('ماژول تابلو برق'));
  assert(!project.includes('data-inventory-stock'));
  const forbidden = renderInventoryWorkspace(state, context({ inventoryProjectId: 'p2' }));
  assert(!forbidden.includes('data-inventory-consumption'));
  assert(!forbidden.includes('data-inventory-stock'));
  assert.match(forbidden, /data-inventory-action="consume" disabled/);
});

test('worker form consumes fractional canonical stock and return restores stock with a visible historical entry', async t => {
  const seed = fixture(); let state = publicState(seed, 'worker'), modal;
  useDocument(t, { querySelector: () => null });
  const changes = [], ctx = context({ modal: value => { modal = value; }, mutate: async (action, payload) => { changes.push({ action, payload }); const result = applyAction(seed, 'worker', action, payload); state = publicState(seed, 'worker'); return result; } });
  openInventoryConsumption(state, ctx, 'p1', 'inv2');
  assert(modal.body.includes('max="500"'));
  assert(!modal.body.includes('name="unitPrice"'));
  assert(!modal.body.includes('name="clientVisible"'));
  assert(!modal.body.includes('همایش ایده‌پرداز'));
  await modal.onSubmit(data({ projectId: 'p1', inventoryId: 'inv2', quantity: '1.125', date: '2026-10-22' }));
  assert.equal(seed.inventory.find(item => item.id === 'inv2').quantity, 498.875);
  assert.deepEqual(Object.keys(changes[0].payload).sort(), ['date', 'inventoryId', 'projectId', 'quantity']);
  const consumed = seed.materials.at(-1);
  assert.equal(consumed.unitPrice, 28000);
  assert.equal(consumed.clientVisible, false);
  const button = buttonFor('return', consumed.id); globalThis.document = documentFor(button);
  wireInventoryWorkspace(state, ctx); button.click();
  assert(modal.body.includes('max="1.125"'));
  assert(modal.body.includes('min="2026-10-22"'));
  await modal.onSubmit(data({ quantity: '0.125', date: '2026-10-22', note: 'مصرف نشد <script>' }));
  assert.equal(seed.inventory.find(item => item.id === 'inv2').quantity, 499);
  assert.equal(seed.materials.at(-1).quantity, 1);
  const html = renderInventoryWorkspace(state, ctx);
  assert(html.includes('مصرف خالص 1 متر'));
  assert(html.includes('برگشت 0.125 متر'));
  assert(html.includes('DATE:2026-10-22'));
  assert(html.includes('مصرف نشد &lt;script&gt;'));
  assert(!html.includes('<script>'));
});

test('warehouse new-stock and receive forms submit domain-supported actions and preserve fractional quantities', async t => {
  const seed = fixture(); let state = publicState(seed, 'warehouse'), modal;
  const ctx = context({ modal: value => { modal = value; }, mutate: async (action, payload) => { const result = applyAction(seed, 'warehouse', action, payload); state = publicState(seed, 'warehouse'); return result; } });
  const create = buttonFor('create'); useDocument(t, documentFor(create));
  wireInventoryWorkspace(state, ctx); create.click();
  await modal.onSubmit(data({ name: 'کابل تست', unit: 'متر', quantity: '0', minQuantity: '1.5', unitPrice: '12000' }));
  const item = seed.inventory.at(-1); assert.equal(item.name, 'کابل تست'); assert.equal(item.quantity, 0);
  const receive = buttonFor('receive', item.id); globalThis.document = documentFor(receive);
  wireInventoryWorkspace(state, ctx); receive.click();
  await modal.onSubmit(data({ quantity: '2.125' }));
  assert.equal(seed.inventory.at(-1).quantity, 2.125);
  assert(renderInventoryWorkspace(state, ctx).includes('COST:12000'));
  // Even an injected replenishment button cannot open the manager form for a worker.
  modal = undefined; globalThis.document = documentFor(buttonFor('receive', item.id));
  const injected = globalThis.document.querySelectorAll('[data-inventory-action]')[0];
  wireInventoryWorkspace(publicState(seed, 'worker'), ctx); injected.click();
  assert.equal(modal, undefined);
});

test('depleted stock and unassigned worker states give usable explanations without opening invalid forms', t => {
  const seed = fixture(); seed.inventory.forEach(item => { item.quantity = 0; });
  let modal, notice;
  const ctx = context({ modal: value => { modal = value; }, toast: value => { notice = value; } });
  useDocument(t, { querySelector: () => null });
  const state = publicState(seed, 'worker');
  assert.match(renderInventoryWorkspace(state, ctx), /با انباردار هماهنگ کنید/);
  openInventoryConsumption(state, ctx); assert.equal(modal, undefined); assert.match(notice, /موجودی قابل برداشت/);
  seed.projects.forEach(project => { project.memberIds = []; });
  const unassigned = publicState(seed, 'worker');
  assert.match(renderInventoryWorkspace(unassigned, ctx), /هنوز پروژه‌ای به شما تخصیص داده نشده/);
  openInventoryConsumption(unassigned, ctx); assert.equal(modal, undefined); assert.match(notice, /پروژهٔ مجاز/);
});
