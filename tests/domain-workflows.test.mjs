import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeedState, publicState, applyAction, DomainError } from '../public/domain.mjs';

const reportInput = overrides => ({ projectId: 'p1', workerId: 'worker', date: '2026-10-18', start: '08:00', end: '14:00', breakMinutes: 30, description: 'نصب و آزمایش دوربین', output: 'چهار دوربین آماده شد', ...overrides });
const storedReport = (state, id) => state.reports.find(report => report.id === id);
const createReport = state => applyAction(state, 'worker', 'report.create', reportInput());
const updateInput = (report, overrides) => ({ ...reportInput(), id: report.id, version: report.version, ...overrides });
function rejectsAtomically(state, action, expected = DomainError) {
  const before = structuredClone(state);
  assert.throws(action, expected);
  assert.deepEqual(state, before, 'failed revisions cannot modify records or audit history');
}

test('an owner can correct a returned report and resubmit without creating another report or labor charge', () => {
  const state = createSeedState();
  const created = createReport(state);
  applyAction(state, 'manager', 'report.review', { id: created.id, status: 'changes_requested', reviewNote: 'شرح تست کامل شود' });
  const count = state.reports.length;
  const previous = structuredClone(storedReport(state, created.id));
  const result = applyAction(state, 'worker', 'report.update', updateInput(previous, { end: '15:00', description: 'نصب و آزمایش تصویر و شبکه تکمیل شد' }));
  const revised = storedReport(state, created.id);
  assert.equal(state.reports.length, count);
  assert.equal(result.id, created.id);
  assert.equal(result.status, 'submitted');
  assert.equal(result.version, previous.version + 1);
  assert.equal(result.minutes, 390);
  assert.equal(revised.rate, previous.rate);
  assert.equal(revised.laborCost, 0);
  assert.equal(revised.createdAt, previous.createdAt);
  assert.equal(revised.reviewedBy, undefined);
  assert.equal(revised.reviewNote, undefined);
  assert.equal(result.rate, undefined);
  assert.equal(result.laborCost, undefined);
  assert.equal(state.audit.at(-1).action, 'report.update');
  assert.equal(state.audit.at(-1).actorId, 'worker');
  assert.equal(state.audit.at(-1).entityId, created.id);
});

test('optimistic report versions prevent stale saves and approval makes every revision immutable', () => {
  const state = createSeedState();
  const created = createReport(state);
  for (const version of [undefined, 0, 1.5, '1']) {
    rejectsAtomically(state, () => applyAction(state, 'worker', 'report.update', updateInput(created, { version })));
  }
  const saved = applyAction(state, 'worker', 'report.update', updateInput(created, { description: 'جزئیات تکمیل شد' }));
  rejectsAtomically(state, () => applyAction(state, 'worker', 'report.update', updateInput(created)), error => error.status === 409 && error.code === 'VERSION_CONFLICT');
  applyAction(state, 'manager', 'report.review', { id: saved.id, status: 'approved' });
  for (const actor of ['worker', 'manager']) {
    rejectsAtomically(state, () => applyAction(state, actor, 'report.update', updateInput(storedReport(state, saved.id))), error => error.status === 409 && error.code === 'IMMUTABLE_REPORT');
  }
});

test('rejected and still-submitted reports can be corrected by their owner or manager', () => {
  for (const status of ['submitted', 'rejected']) {
    const state = createSeedState();
    const created = createReport(state);
    if (status === 'rejected') applyAction(state, 'manager', 'report.review', { id: created.id, status, reviewNote: 'اطلاعات اصلاح شود' });
    const current = storedReport(state, created.id);
    const revised = applyAction(state, 'manager', 'report.update', updateInput(current, { output: 'آزمایش نهایی ثبت شد', status: 'approved', laborCost: 999999999, rate: 1 }));
    assert.equal(revised.status, 'submitted');
    assert.equal(revised.laborCost, 0);
    assert.equal(revised.rate, 150000);
  }
});

test('a report keeps its captured rate for the same work date and reselects the historical rate when its date changes', () => {
  const state = createSeedState();
  const created = createReport(state);
  applyAction(state, 'manager', 'worker.rate', { id: 'worker', hourlyRate: 190000, effectiveDate: '2026-10-10' });
  const sameDate = applyAction(state, 'manager', 'report.update', updateInput(created, { description: 'توضیح اصلاح شد' }));
  assert.equal(sameDate.rate, 150000, 'backdated rate entries do not rewrite an existing capture');
  const changedDate = applyAction(state, 'manager', 'report.update', updateInput(sameDate, { date: '2026-10-19' }));
  assert.equal(changedDate.rate, 190000);
  rejectsAtomically(state, () => applyAction(state, 'manager', 'report.update', updateInput(changedDate, { date: '2025-12-31' })));
});

test('report revisions enforce ownership, both project scopes, member identity and full work-field validation atomically', () => {
  const state = createSeedState();
  const created = createReport(state);
  for (const actor of ['worker2', 'customer']) {
    rejectsAtomically(state, () => applyAction(state, actor, 'report.update', updateInput(created)), error => error.status === 403);
  }
  for (const actor of ['worker', 'manager']) {
    rejectsAtomically(state, () => applyAction(state, actor, 'report.update', updateInput(created, { workerId: 'worker2' })), error => error.status === 403);
  }
  rejectsAtomically(state, () => applyAction(state, 'worker', 'report.update', updateInput(created, { projectId: 'p2' })), error => error.status === 403);
  rejectsAtomically(state, () => applyAction(state, 'manager', 'report.update', updateInput(created, { projectId: 'p2' })), error => error.status === 403);
  for (const overrides of [{ date: '2026-02-30' }, { start: '24:00' }, { end: '07:00' }, { breakMinutes: 360 }, { breakMinutes: 0.5 }, { description: '' }, { output: {} }]) {
    rejectsAtomically(state, () => applyAction(state, 'worker', 'report.update', updateInput(created, overrides)));
  }
  const moved = applyAction(state, 'worker', 'report.update', updateInput(created, { projectId: 'p3' }));
  assert.equal(moved.projectId, 'p3');
  assert.equal(moved.workerId, 'worker');
  assert.equal(moved.rate, undefined);
});

test('manager assignment changes alter current scope without deleting reports or financial records', () => {
  const state = createSeedState();
  const created = createReport(state);
  const before = structuredClone({ reports: state.reports, materials: state.materials, invoices: state.invoices, receipts: state.receipts });
  const result = applyAction(state, 'manager', 'project.update', { id: 'p1', customerId: 'customer2', memberIds: ['worker3', 'worker3'] });
  assert.equal(result.customerId, 'customer2');
  assert.deepEqual(result.memberIds, ['worker3']);
  assert.deepEqual({ reports: state.reports, materials: state.materials, invoices: state.invoices, receipts: state.receipts }, before);
  assert.equal(publicState(state, 'customer').projects.some(project => project.id === 'p1'), false);
  assert.ok(publicState(state, 'customer2').invoices.some(invoice => invoice.id === 'i2'));
  assert.equal(publicState(state, 'worker').reports.some(report => report.id === created.id), false);
  rejectsAtomically(state, () => applyAction(state, 'worker', 'report.update', updateInput(created)), error => error.status === 403);
  rejectsAtomically(state, () => applyAction(state, 'manager', 'report.update', updateInput(created)), error => error.status === 403);
  applyAction(state, 'manager', 'project.update', { id: 'p1', customerId: null, memberIds: [] });
  assert.equal(state.projects.find(project => project.id === 'p1').customerId, null);
  assert.equal(publicState(state, 'customer2').projects.some(project => project.id === 'p1'), false);
});

test('invalid project assignment updates and nonmanager attempts leave all existing scope unchanged', () => {
  const state = createSeedState();
  for (const overrides of [{ customerId: 'worker' }, { customerId: 'missing' }, { customerId: false }, { customerId: {} }, { memberIds: ['customer'] }, { memberIds: ['missing'] }, { memberIds: [1] }, { memberIds: 'worker' }]) {
    rejectsAtomically(state, () => applyAction(state, 'manager', 'project.update', { id: 'p1', progress: 99, ...overrides }));
  }
  for (const actor of ['worker', 'customer']) {
    rejectsAtomically(state, () => applyAction(state, actor, 'project.update', { id: 'p1', customerId: 'customer2', memberIds: [] }), error => error.status === 403);
  }
});

test('an empty production inventory supports new zero-stock products, receiving, and fractional stock', () => {
  const state = createSeedState();
  state.inventory = [];
  const created = applyAction(state, 'manager', 'inventory.create', { name: ' کابل فیبر ', unit: ' متر ', quantity: 0, minQuantity: 10.125, unitPrice: 15000 });
  assert.equal(created.name, 'کابل فیبر');
  assert.equal(created.unit, 'متر');
  assert.equal(created.quantity, 0);
  assert.equal(created.minQuantity, 10.125);
  assert.equal(state.inventory.length, 1);
  applyAction(state, 'manager', 'inventory.receive', { id: created.id, quantity: 1.125 });
  assert.equal(state.inventory[0].quantity, 1.125);
  const fractional = applyAction(state, 'manager', 'inventory.create', { name: 'کابل شبکه', unit: 'متر', quantity: 12.001, minQuantity: 0, unitPrice: 0 });
  assert.equal(fractional.quantity, 12.001);
  assert.equal(state.audit.at(-1).action, 'inventory.create');
  assert.equal(publicState(state, 'worker').inventory.length, 0);
});

test('inventory creation rejects unauthorized users, invalid quantities and fractional money atomically', () => {
  const state = createSeedState();
  const payload = { name: 'دوربین', unit: 'عدد', quantity: 0, minQuantity: 0, unitPrice: 3500000 };
  for (const actor of ['worker', 'customer']) {
    rejectsAtomically(state, () => applyAction(state, actor, 'inventory.create', payload), error => error.status === 403);
  }
  for (const overrides of [{ name: '' }, { unit: '' }, { quantity: -1 }, { quantity: 0.0001 }, { quantity: Infinity }, { quantity: '1' }, { quantity: Number.MAX_SAFE_INTEGER }, { minQuantity: -1 }, { minQuantity: 0.0001 }, { minQuantity: NaN }, { unitPrice: -1 }, { unitPrice: 1.5 }, { unitPrice: Number.MAX_SAFE_INTEGER + 1 }]) {
    rejectsAtomically(state, () => applyAction(state, 'manager', 'inventory.create', { ...payload, ...overrides }));
  }
});
