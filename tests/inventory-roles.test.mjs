import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createSeedState, publicState, projectAccess } from '../public/domain.mjs';

function fixture() {
  const state = createSeedState();
  state.users.push(
    { id: 'warehouse', name: 'انباردار', username: 'warehouse.one', phone: '+989121111111', role: 'warehouse' },
    { id: 'accountant', name: 'حسابدار', username: 'finance.one', phone: '+989122222222', role: 'accountant' },
  );
  return state;
}
const consume = overrides => ({ projectId: 'p1', inventoryId: 'inv2', quantity: 1.125, date: '2026-10-22', ...overrides });
function rejectsUnchanged(state, actor, action, payload, predicate = error => error.status === 403) {
  const before = structuredClone(state);
  assert.throws(() => applyAction(state, actor, action, payload), predicate);
  assert.deepEqual(state, before, `${action} rejection must preserve stock, records and audit`);
}

test('warehouse snapshot contains stock work context without customer contact, payroll, finance or conversation', () => {
  const state = fixture();
  const record = applyAction(state, 'worker', 'material.consume', consume());
  const view = publicState(state, 'warehouse');
  assert.equal(view.inventory.length, state.inventory.length);
  assert.equal(view.projects.length, state.projects.length);
  assert.deepEqual(Object.keys(view.projects[0]).sort(), ['id', 'name', 'status', 'type']);
  for (const list of ['reports', 'invoices', 'receipts', 'messages', 'tickets', 'audit']) assert.deepEqual(view[list], []);
  assert.equal(view.materials.find(item => item.id === record.id).unitPrice, 28000);
  const coworker = view.users.find(item => item.id === 'worker');
  assert(coworker);
  for (const key of ['phone', 'email', 'hourlyRate', 'rateHistory', 'username']) assert.equal(coworker[key], undefined);
  assert.equal(view.users.some(item => item.id === 'customer'), false);
});

test('accountant can issue invoices and register receipts but cannot administer accounts, stock or operational messages', () => {
  const state = fixture(), view = publicState(state, 'accountant');
  assert.equal(view.projects.length, state.projects.length);
  assert.equal(view.projects[0].budget, state.projects[0].budget);
  assert.equal(view.reports.length, state.reports.length);
  assert.equal(view.users.find(item => item.id === 'worker').hourlyRate, 150000);
  for (const key of ['location', 'description', 'clientNote', 'contactIds', 'publicTitle']) assert.equal(view.projects[0][key], undefined);
  for (const list of ['messages', 'tickets', 'audit']) assert.deepEqual(view[list], []);
  for (const person of view.users.filter(item => item.id !== 'accountant')) {
    assert.equal(person.phone, undefined); assert.equal(person.email, undefined);
  }
  const invoice = applyAction(state, 'accountant', 'invoice.create', { projectId: 'p2', title: 'مرحله اجرا', amount: 150000, dueDate: '2026-10-24' });
  applyAction(state, 'accountant', 'payment.record', { invoiceId: invoice.id, amount: 50000, reference: 'ROLE-TEST-001' });
  assert.equal(state.invoices.find(item => item.id === invoice.id).paid, 50000);
  for (const [action, payload] of [
    ['account.update', { id: 'worker', role: 'customer' }], ['account.archive', { id: 'worker' }],
    ['inventory.receive', { id: 'inv2', quantity: 1 }], ['material.consume', consume()],
    ['report.review', { id: 'r2', status: 'approved' }], ['project.update', { id: 'p1', progress: 99 }],
    ['message.send', { projectId: 'p1', text: 'private' }], ['ticket.create', { projectId: 'p1', subject: 'test', description: 'test' }],
  ]) rejectsUnchanged(state, 'accountant', action, payload);
});

test('warehouse manages product entries and receipts but cannot perform finance, account or project administration', () => {
  const state = fixture();
  const product = applyAction(state, 'warehouse', 'inventory.create', { name: 'فیبر', unit: 'متر', quantity: 0, minQuantity: 1, unitPrice: 30000 });
  applyAction(state, 'warehouse', 'inventory.receive', { id: product.id, quantity: 4.125 });
  assert.equal(state.inventory.find(item => item.id === product.id).quantity, 4.125);
  const material = applyAction(state, 'warehouse', 'material.consume', consume({ projectId: 'p2', inventoryId: product.id, quantity: 2.125 }));
  assert.equal(material.projectId, 'p2'); assert.equal(material.unitPrice, 30000);
  for (const [action, payload] of [
    ['invoice.create', { projectId: 'p1', title: 'forbidden', amount: 1, dueDate: '2026-10-22' }],
    ['payment.record', { invoiceId: 'i2', amount: 1, reference: 'forbidden' }],
    ['worker.rate', { id: 'worker', hourlyRate: 1, effectiveDate: '2026-10-22' }],
    ['account.update', { id: 'worker', name: 'forbidden' }], ['project.update', { id: 'p1', progress: 99 }],
    ['message.send', { projectId: 'p1', text: 'forbidden' }],
  ]) rejectsUnchanged(state, 'warehouse', action, payload);
});

test('assigned worker consumes canonical stock and returns fractional goods with stock conservation and append-only history', () => {
  const state = fixture(), beforeStock = state.inventory.find(item => item.id === 'inv2').quantity;
  const created = applyAction(state, 'worker', 'material.consume', consume());
  assert.equal(created.unitPrice, undefined);
  assert.equal(created.name, 'کابل شبکه Cat6');
  assert.equal(created.clientVisible, false);
  assert.equal(state.inventory.find(item => item.id === 'inv2').quantity, beforeStock - 1.125);
  const first = applyAction(state, 'worker2', 'material.return', { id: created.id, quantity: 0.125, date: '2026-10-23', note: 'کابل استفاده‌نشده' });
  const firstLedgerEntry = structuredClone(first.returns[0]);
  const final = applyAction(state, 'worker', 'material.return', { id: created.id, quantity: 1, date: '2026-10-24' });
  assert.equal(final.quantity, 0); assert.equal(final.originalQuantity, 1.125); assert.equal(final.returnedQuantity, 1.125);
  assert.equal(final.returns.length, 2); assert.deepEqual(final.returns[0], firstLedgerEntry);
  assert.equal(state.inventory.find(item => item.id === 'inv2').quantity, beforeStock);
  assert.equal(state.materials.find(item => item.id === created.id).unitPrice, 28000);
  assert.equal(final.unitPrice, undefined);
  assert.equal(state.audit.at(-1).actorId, 'worker');
  assert.equal(publicState(state, 'customer').materials.some(item => item.id === created.id), false);
});

test('workers cannot cross project boundaries, manufacture global stock, override prices or publish client costs', () => {
  const state = fixture();
  const view = publicState(state, 'worker');
  assert.deepEqual(view.inventory, []); assert.equal(view.stockCatalog.length, state.inventory.length);
  assert(view.stockCatalog.every(item => !('unitPrice' in item)));
  for (const [action, payload] of [
    ['material.consume', consume({ projectId: 'p2' })],
    ['inventory.receive', { id: 'inv2', quantity: 10 }],
    ['inventory.create', { name: 'x', unit: 'm', quantity: 10, minQuantity: 0, unitPrice: 0 }],
    ['material.consume', consume({ clientVisible: true })],
  ]) rejectsUnchanged(state, 'worker', action, payload);
  for (const key of ['name', 'unit', 'unitPrice']) rejectsUnchanged(state, 'worker', 'material.consume', consume({ [key]: key === 'unitPrice' ? 0 : 'forged' }), error => error.status === 400);
  const other = applyAction(state, 'warehouse', 'material.consume', consume({ projectId: 'p2' }));
  rejectsUnchanged(state, 'worker', 'material.return', { id: other.id, quantity: 1, date: '2026-10-23' });
  rejectsUnchanged(state, 'customer', 'material.consume', consume());
  rejectsUnchanged(state, 'customer', 'material.return', { id: 'm1', quantity: 1, date: '2026-10-23' });
});

test('stock shortages, excess returns, invalid dates and invalid fractional amounts fail atomically', () => {
  const state = fixture(), created = applyAction(state, 'worker', 'material.consume', consume());
  for (const quantity of [0, -1, 0.0001, NaN, Infinity, '1', Number.MAX_SAFE_INTEGER]) {
    rejectsUnchanged(state, 'worker', 'material.consume', consume({ quantity }), error => error.status === 400);
    rejectsUnchanged(state, 'worker', 'material.return', { id: created.id, quantity, date: '2026-10-23' }, error => error.status === 400);
  }
  rejectsUnchanged(state, 'worker', 'material.consume', consume({ quantity: 100000 }), error => error.code === 'INSUFFICIENT_STOCK');
  rejectsUnchanged(state, 'worker', 'material.return', { id: created.id, quantity: 1.126, date: '2026-10-23' }, error => error.code === 'EXCESS_RETURN');
  rejectsUnchanged(state, 'worker', 'material.return', { id: created.id, quantity: 1, date: '2026-10-21' }, error => error.status === 400);
  rejectsUnchanged(state, 'worker', 'material.return', { id: 'm3', quantity: 1, date: '2026-10-23' }, error => error.code === 'NO_STOCK_SOURCE');
  rejectsUnchanged(state, 'worker', 'material.consume', consume({ date: '2026-02-30' }), error => error.status === 400);
});

test('returns on earlier material rows preserve the original consumption and reduce current financial cost', () => {
  const state = fixture(), before = structuredClone(state.materials.find(item => item.id === 'm2'));
  const returned = applyAction(state, 'warehouse', 'material.return', { id: 'm2', quantity: 30.125, date: '2026-10-23', note: 'مانده پروژه' });
  assert.equal(returned.originalQuantity, before.quantity);
  assert.equal(returned.returnedQuantity, 30.125);
  assert.equal(returned.quantity, 149.875);
  assert.equal(returned.date, before.date); assert.equal(returned.unitPrice, before.unitPrice);
  assert.equal(returned.returns[0].recordedBy, 'warehouse');
  assert.equal(publicState(state, 'accountant').materials.find(item => item.id === 'm2').quantity * before.unitPrice, 4196500);
});

test('archive cuts access and eligibility while preserving report, finance and project references; restore reuses the account', () => {
  const state = fixture(), historical = structuredClone({ projects: state.projects, reports: state.reports, materials: state.materials, invoices: state.invoices, receipts: state.receipts });
  const result = applyAction(state, 'manager', 'account.archive', { id: 'worker' });
  assert.equal(result.id, 'worker'); assert(result.deletedAt);
  assert.equal(projectAccess(state, 'worker', 'p1'), false);
  assert.throws(() => publicState(state, 'worker'), error => error.status === 401);
  rejectsUnchanged(state, 'worker', 'material.consume', consume(), error => error.status === 401);
  rejectsUnchanged(state, 'manager', 'report.create', { projectId: 'p1', workerId: 'worker', date: '2026-10-22', start: '09:00', end: '10:00', description: 'test' }, error => error.status === 403);
  assert.deepEqual({ projects: state.projects, reports: state.reports, materials: state.materials, invoices: state.invoices, receipts: state.receipts }, historical);
  assert(publicState(state, 'manager').users.find(item => item.id === 'worker').deletedAt);
  const restored = applyAction(state, 'manager', 'account.restore', { id: 'worker' });
  assert.equal(restored.deletedAt, undefined); assert.equal(restored.id, 'worker'); assert(projectAccess(state, 'worker', 'p1'));
  assert.equal(state.users.filter(item => item.id === 'worker').length, 1);
  for (const actor of ['worker', 'warehouse', 'accountant', 'customer']) rejectsUnchanged(state, actor, 'account.archive', { id: 'worker2' });
  rejectsUnchanged(state, 'manager', 'account.archive', { id: 'manager' }, error => error.code === 'MANAGER_ROLE_PROTECTED');
});

test('warehouse role requires a unique username and role changes preserve historical finance and wage data', () => {
  const state = fixture(), before = structuredClone({ reports: state.reports, materials: state.materials, invoices: state.invoices, receipts: state.receipts }), rate = structuredClone(state.users.find(item => item.id === 'worker').rateHistory);
  rejectsUnchanged(state, 'manager', 'account.update', { id: 'worker', role: 'warehouse' }, error => error.code === 'USERNAME_REQUIRED');
  rejectsUnchanged(state, 'manager', 'account.update', { id: 'worker', role: 'warehouse', username: 'WAREHOUSE.ONE' }, error => error.code === 'DUPLICATE_USERNAME');
  const changed = applyAction(state, 'manager', 'account.update', { id: 'worker', role: 'warehouse', username: 'Warehouse.Two' });
  assert.equal(changed.username, 'warehouse.two'); assert.equal(changed.role, 'warehouse');
  assert(state.projects.every(item => !item.memberIds.includes('worker') && item.customerId !== 'worker'));
  assert.deepEqual(state.users.find(item => item.id === 'worker').rateHistory, rate);
  assert.deepEqual({ reports: state.reports, materials: state.materials, invoices: state.invoices, receipts: state.receipts }, before);
  rejectsUnchanged(state, 'manager', 'account.update', { id: 'worker', role: 'manager' }, error => error.status === 400);
});
