import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createSeedState, publicState } from '../public/domain.mjs';
import { renderInventoryWorkspace, wireInventoryWorkspace } from '../public/inventory-workspace.mjs';

const fixture = () => {
  const state = createSeedState();
  state.users.push({ id: 'warehouse', name: 'انباردار', role: 'warehouse' }, { id: 'accountant', name: 'حسابدار', role: 'accountant' });
  return state;
};
const product = (state, quantity = 0) => applyAction(state, 'manager', 'inventory.create', { name: 'کالای آزمایشی', unit: 'متر', quantity, minQuantity: 0, unitPrice: 1000 });
const removal = item => ({ id: item.id, expectedQuantity: item.quantity, confirmed: true });
function rejectsUnchanged(state, actor, action, payload, code) {
  const before = structuredClone(state);
  assert.throws(() => applyAction(state, actor, action, payload), error => error.code === code);
  assert.deepEqual(state, before);
}

test('manager and warehouse may remove unused zero-stock items while keeping financial records and an audit trail', () => {
  for (const actor of ['manager', 'warehouse']) {
    const state = fixture(), item = product(state), before = structuredClone({ invoices: state.invoices, receipts: state.receipts, materials: state.materials });
    assert.deepEqual(applyAction(state, actor, 'inventory.delete', removal(item)), { id: item.id, removed: true, archived: false });
    assert(!state.inventory.some(row => row.id === item.id));
    assert.deepEqual({ invoices: state.invoices, receipts: state.receipts, materials: state.materials }, before);
    assert.equal(state.audit.at(-1).actorId, actor);
    assert.match(state.audit.at(-1).description, /کالای آزمایشی/);
  }
});

test('stock with quantity or consumption is archived outside active catalogs and can be restored without changing quantities or history', () => {
  const state = fixture(), item = product(state, 4.125);
  const consumption = applyAction(state, 'worker', 'material.consume', { projectId: 'p1', inventoryId: item.id, quantity: 1.125, date: '2026-10-25' });
  const before = structuredClone({ materials: state.materials, invoices: state.invoices, receipts: state.receipts });
  const archived = applyAction(state, 'manager', 'inventory.delete', { ...removal(item), expectedQuantity: 3 });
  assert.equal(archived.archived, true);
  assert.equal(state.inventory.find(row => row.id === item.id).quantity, 3);
  assert.deepEqual({ materials: state.materials, invoices: state.invoices, receipts: state.receipts }, before);
  for (const role of ['manager', 'warehouse', 'accountant']) {
    const view = publicState(state, role);
    assert(!view.inventory.some(row => row.id === item.id));
    assert.equal(view.archivedInventory.find(row => row.id === item.id).quantity, 3);
  }
  const worker = publicState(state, 'worker');
  assert(!worker.stockCatalog.some(row => row.id === item.id));
  assert.deepEqual(worker.archivedInventory, []);
  assert.equal(worker.materials.find(row => row.id === consumption.id).quantity, 1.125);
  applyAction(state, 'warehouse', 'inventory.restore', { id: item.id });
  assert.equal(publicState(state, 'manager').inventory.find(row => row.id === item.id).quantity, 3);
  assert.equal(publicState(state, 'manager').archivedInventory.length, 0);
  assert.deepEqual({ materials: state.materials, invoices: state.invoices, receipts: state.receipts }, before);
});

test('deletion requires explicit confirmation and the displayed quantity; unauthorized or stale attempts are atomic', () => {
  const state = fixture(), item = product(state, 1.125);
  for (const actor of ['worker', 'customer', 'accountant']) {
    rejectsUnchanged(state, actor, 'inventory.delete', removal(item), 'FORBIDDEN');
    rejectsUnchanged(state, actor, 'inventory.restore', { id: item.id }, 'FORBIDDEN');
  }
  rejectsUnchanged(state, 'manager', 'inventory.delete', { ...removal(item), confirmed: false }, 'CONFIRMATION_REQUIRED');
  rejectsUnchanged(state, 'manager', 'inventory.delete', { ...removal(item), confirmed: 'true' }, 'CONFIRMATION_REQUIRED');
  applyAction(state, 'warehouse', 'inventory.receive', { id: item.id, quantity: .125 });
  rejectsUnchanged(state, 'manager', 'inventory.delete', removal(item), 'STOCK_CHANGED');
});

test('archived items reject new receipts and consumption while historical returns still conserve physical stock', () => {
  const state = fixture(), item = product(state, 1.125);
  const used = applyAction(state, 'worker', 'material.consume', { projectId: 'p1', inventoryId: item.id, quantity: 1.125, date: '2026-10-25' });
  const archived = applyAction(state, 'manager', 'inventory.delete', { ...removal(item), expectedQuantity: 0 });
  assert.equal(archived.archived, true, 'A zero-stock item with consumption history must remain addressable');
  for (const actor of ['manager', 'warehouse']) rejectsUnchanged(state, actor, 'inventory.receive', { id: item.id, quantity: 1 }, 'STOCK_ARCHIVED');
  for (const actor of ['manager', 'warehouse', 'worker']) rejectsUnchanged(state, actor, 'material.consume', { projectId: 'p1', inventoryId: item.id, quantity: .125, date: '2026-10-25' }, 'STOCK_ARCHIVED');
  rejectsUnchanged(state, 'manager', 'material.create', { projectId: 'p1', inventoryId: item.id, quantity: .125, unit: 'متر', unitPrice: 1000, name: item.name, date: '2026-10-25' }, 'STOCK_ARCHIVED');
  applyAction(state, 'worker', 'material.return', { id: used.id, quantity: .125, date: '2026-10-25', note: 'مصرف نشده' });
  const archivedItem = state.inventory.find(row => row.id === item.id);
  assert.equal(archivedItem.quantity, .125);
  assert(archivedItem.archivedAt);
  assert.equal(state.materials.find(row => row.id === used.id).quantity, 1);
});

test('task instructions stay in the assigned project and only the manager may edit them', () => {
  const state = fixture();
  const task = applyAction(state, 'manager', 'task.create', { projectId: 'p1', title: 'بازدید محل', description: ' فردا ابتدا با سرپرست هماهنگ کنید. ', assigneeId: 'worker', dueDate: '2026-10-26' });
  assert.equal(task.description, 'فردا ابتدا با سرپرست هماهنگ کنید.');
  assert.equal(publicState(state, 'worker').projects.find(project => project.id === 'p1').tasks.find(row => row.id === task.id).description, task.description);
  assert.equal(publicState(state, 'customer').projects.find(project => project.id === 'p1').tasks, undefined);
  rejectsUnchanged(state, 'worker', 'task.update', { projectId: 'p1', id: task.id, version: task.version, description: 'ویرایش غیرمجاز' }, 'FORBIDDEN');
  rejectsUnchanged(state, 'manager', 'task.update', { projectId: 'p1', id: task.id, version: task.version, description: 'x'.repeat(2001) }, 'INVALID_INPUT');
  applyAction(state, 'worker', 'task.update', { projectId: 'p1', id: task.id, version: task.version, status: 'in_progress' });
  const changed = state.projects.find(project => project.id === 'p1').tasks.find(row => row.id === task.id);
  assert.equal(changed.description, task.description);
});

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const context = extra => ({ e: escape, n: String, money: String, date: String, today: () => '2026-10-25', ...extra });
const formData = values => { const data = new FormData(); for (const [key, value] of Object.entries(values)) data.set(key, value); return data; };

test('inventory removal UI displays the actual stock and confirmation, then exposes restore rather than new stock operations', async t => {
  const previous = globalThis.document;
  t.after(() => previous === undefined ? delete globalThis.document : globalThis.document = previous);
  const seed = fixture(), item = product(seed, 1.125); let modal, view = publicState(seed, 'manager');
  const ctx = context({ modal: value => { modal = value; }, mutate: async (action, payload) => { const result = applyAction(seed, 'manager', action, payload); view = publicState(seed, 'manager'); return result; } });
  const bind = (action, state = view) => {
    const button = { dataset: { inventoryAction: action, inventoryId: item.id }, addEventListener: (_, listener) => { button.click = listener; } };
    globalThis.document = { querySelector: () => null, querySelectorAll: selector => selector === '[data-inventory-action]' ? [button] : [] };
    wireInventoryWorkspace(state, ctx); button.click();
  };
  bind('delete');
  assert.match(modal.body, /1.125 متر/);
  assert.match(modal.body, /name="confirmed" required/);
  await assert.rejects(modal.onSubmit(formData({})), error => error.code === 'CONFIRMATION_REQUIRED');
  await modal.onSubmit(formData({ confirmed: 'on' }));
  const html = renderInventoryWorkspace(view, ctx);
  assert.match(html, /data-inventory-action="restore"/);
  assert(!html.includes(`data-inventory-action="consume" data-inventory-id="${item.id}"`));
  assert(!html.includes(`data-inventory-action="receive" data-inventory-id="${item.id}"`));
  bind('restore'); await modal.onSubmit(formData({}));
  assert(view.inventory.some(row => row.id === item.id));
  modal = undefined; bind('delete', publicState(seed, 'worker')); assert.equal(modal, undefined);
});
