import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicLead, listLeads, updateLeadStatus } from '../supabase/functions/arios-api/lead-service.mjs';

const payload = { phone: '۰۹۱۲۳۴۵۶۷۸۹', name: 'مشتری', message: 'نصب دوربین', consent: true, requestId: '01234567-89ab-4cde-8f01-234567890abc', clientId: 'a'.repeat(64) };
function fixture() {
  const rows = new Map(), limits = [], calls = { create: 0, list: 0, update: 0 };
  const repo = {
    findLeadRequest: async id => rows.get(id) || null,
    rateLimit: async (...args) => { limits.push(args); return { allowed: true }; },
    createLead: async input => {
      calls.create++;
      if (rows.has(input.requestId)) return { created: false, lead: rows.get(input.requestId) };
      const row = { id: '11111111-2222-4333-8444-555555555555', request_id: input.requestId, request_hash: input.requestHash, phone: input.phone, name: input.name, message: input.message, status: 'new', created_at: '2026-10-24T12:00:00Z', updated_at: '2026-10-24T12:00:00Z' };
      rows.set(input.requestId, row);
      return { created: true, lead: row };
    },
    listLeads: async () => { calls.list++; return [...rows.values()]; },
    updateLeadStatus: async (id, status) => { calls.update++; const row = [...rows.values()].find(row => row.id === id); if (row) Object.assign(row, { status, updated_at: '2026-10-24T13:00:00Z' }); return row || null; },
  };
  return { repo, rows, limits, calls };
}

test('callback consent saves a canonical phone once and returns a minimal durable receipt on retries', async () => {
  const f = fixture();
  const saved = await createPublicLead({ repo: f.repo, payload });
  const retry = await createPublicLead({ repo: f.repo, payload });
  assert.equal(saved.accepted, true); assert.equal(saved.created, true); assert.equal(retry.created, false);
  assert.deepEqual(saved.lead, retry.lead);
  assert.equal(f.rows.size, 1); assert.equal(f.calls.create, 1);
  assert.equal([...f.rows.values()][0].phone, '+989123456789');
  assert.equal(f.limits.length, 4, 'A successful retry reuses its acknowledgement without consuming fresh request quota');
  const receipt = JSON.stringify(saved);
  for (const privateValue of ['+989123456789', 'مشتری', 'نصب دوربین', 'request_hash']) assert(!receipt.includes(privateValue));
  assert.match(saved.message, /ثبت شد/);
});

test('callback request ids cannot overwrite earlier contact details and concurrent retries remain one lead', async () => {
  const f = fixture();
  const both = await Promise.all([createPublicLead({ repo: f.repo, payload }), createPublicLead({ repo: f.repo, payload })]);
  assert.equal(f.rows.size, 1); assert.equal(both.filter(x => x.created).length, 1);
  await assert.rejects(createPublicLead({ repo: f.repo, payload: { ...payload, phone: '09999999999' } }), error => error.status === 409 && error.code === 'REQUEST_ID_CONFLICT');
  assert.equal([...f.rows.values()][0].phone, '+989123456789');
});

test('invalid or unconsented callbacks and durable rate limits cannot create records', async () => {
  for (const [patch, code] of [[{ consent: false }, 'CONSENT_REQUIRED'], [{ consent: 'true' }, 'CONSENT_REQUIRED'], [{ phone: 'abc' }, 'PHONE_INVALID'], [{ requestId: '../state' }, 'REQUEST_ID_INVALID']]) {
    const f = fixture();
    await assert.rejects(createPublicLead({ repo: f.repo, payload: { ...payload, ...patch } }), error => error.status === 400 && error.code === code);
    assert.equal(f.rows.size, 0); assert.equal(f.calls.create, 0);
  }
  const f = fixture(); f.repo.rateLimit = async () => ({ allowed: false });
  await assert.rejects(createPublicLead({ repo: f.repo, payload }), error => error.status === 429 && error.code === 'RATE_LIMITED');
  assert.equal(f.calls.create, 0);
});

test('a failed or uncertain write never returns a callback acknowledgement', async () => {
  const f = fixture(); f.repo.createLead = async () => { throw new Error('database unavailable'); };
  await assert.rejects(createPublicLead({ repo: f.repo, payload }), /database unavailable/);
  f.repo.createLead = async () => ({ created: false, lead: null });
  await assert.rejects(createPublicLead({ repo: f.repo, payload }), error => error.code === 'LEAD_NOT_SAVED');
});

test('only managers can read callback phones and change lead status', async () => {
  const f = fixture(); await createPublicLead({ repo: f.repo, payload });
  for (const role of ['worker', 'customer', 'warehouse', 'accountant', undefined]) {
    await assert.rejects(listLeads({ repo: f.repo, user: { role } }), error => error.status === 403);
    await assert.rejects(updateLeadStatus({ repo: f.repo, user: { role }, id: '11111111-2222-4333-8444-555555555555', payload: { status: 'closed' } }), error => error.status === 403);
  }
  assert.equal(f.calls.list, 0); assert.equal(f.calls.update, 0);
  const result = await listLeads({ repo: f.repo, user: { role: 'manager' } });
  assert.deepEqual(Object.keys(result.leads[0]).sort(), ['id', 'name', 'phone', 'message', 'status', 'createdAt', 'updatedAt'].sort());
  assert.equal(result.leads[0].phone, '+989123456789');
  const changed = await updateLeadStatus({ repo: f.repo, user: { role: 'manager' }, id: result.leads[0].id, payload: { status: 'contacted' } });
  assert.equal(changed.lead.status, 'contacted');
  await assert.rejects(updateLeadStatus({ repo: f.repo, user: { role: 'manager' }, id: result.leads[0].id, payload: { status: 'sent' } }), error => error.code === 'LEAD_STATUS_INVALID');
  await assert.rejects(updateLeadStatus({ repo: f.repo, user: { role: 'manager' }, id: '99999999-2222-4333-8444-555555555555', payload: { status: 'closed' } }), error => error.code === 'LEAD_NOT_FOUND');
});
