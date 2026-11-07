// STORY-009 — the vendor conformance check (REQ-054): passes against a good feed, names every problem
// against a bad one, and never hangs or retries forever.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { openDatabase } from '../server/db.js';
import { createApiClient } from '../server/api/clients.js';
import { createApiServer } from '../server/api/server.js';
import { createWorkOrder } from '../server/workOrders.js';
import { runVendorCheck, formatReport } from '../server/vendorCheck.js';

const noWait = () => Promise.resolve();

async function realSystem(workOrders = 3) {
  const db = openDatabase();
  const key = createApiClient(db, { name: 'Lama', scopes: ['vendor_feed:lama'], actor: 'admin-1' }).key;
  for (let i = 1; i <= workOrders; i += 1) {
    await createWorkOrder(db, { title: `Leak ${i}`, work_type: 'water_leak', location_text: 'Stand-in', created_by: 'clerk-1' }, { now: () => `2026-11-0${i}T09:00:00.000Z` });
  }
  const server = createApiServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { db, key, baseUrl: `http://127.0.0.1:${server.address().port}`, stop: () => new Promise((resolve) => server.close(resolve)) };
}

test('against a good feed, every check passes, paging through several pages', async (t) => {
  const { key, baseUrl, stop } = await realSystem(5);
  t.after(stop);
  const report = await runVendorCheck({ baseUrl, vendor: 'lama', key, pageSize: 2, wait: noWait });
  assert.equal(report.passed, true, formatReport(report));
  assert.deepEqual(report.checks.map((c) => c.name), [
    'contract published', 'refuses requests without a key', 'feed answers with the vendor key',
    'every record matches the contract', 'paging never repeats a record', 'the saved cursor resumes with nothing new',
  ]);
  assert.match(report.checks[2].detail, /5 record\(s\) in 3 page\(s\)/);
});

test('the report never contains the key', async (t) => {
  const { key, baseUrl, stop } = await realSystem(1);
  t.after(stop);
  const text = formatReport(await runVendorCheck({ baseUrl, vendor: 'lama', key, wait: noWait }));
  assert.ok(!text.includes(key) && !text.includes(key.slice(13)));
});

test('a wrong key fails at once and is not retried', async (t) => {
  const { db, baseUrl, stop } = await realSystem(1);
  t.after(stop);
  const otherKey = createApiClient(db, { name: 'SpryPoint', scopes: ['vendor_feed:sprypoint'], actor: 'admin-1' }).key;
  const report = await runVendorCheck({ baseUrl, vendor: 'lama', key: otherKey, attempts: 3, wait: noWait });
  assert.equal(report.passed, false);
  assert.match(report.checks.find((c) => c.name === 'feed answers with the vendor key').detail, /answered 403/);
  const denied = db.prepare("SELECT COUNT(*) AS n FROM vendor_exchange_log WHERE outcome = 'denied' AND client_name = 'SpryPoint'").get().n;
  assert.equal(denied, 1, 'one request, no retries');
});

test('data that breaks the contract is reported field by field', async () => {
  // A stand-in feed that sends a record with an extra field and a bad date.
  const fetchImpl = async (url, { headers }) => {
    const json = (status, body) => ({ status, json: async () => body });
    if (url.endsWith('/vendors')) return json(200, { items: [{ key: 'lama', contracts: [{ version: 1, status: 'proposed', fields: ['id'] }] }] });
    if (!headers.Authorization) return json(401, { message: 'A valid API key is required' });
    const bad = { id: 'wo-1', work_type: 'leak', priority: 'normal', status: 'open', address: null, latitude: null, longitude: null, asset_ids: [], created_at: 'yesterday', updated_at: '2026-11-01T00:00:00Z', completed_at: null, title: 'Mrs Jones' };
    return json(200, url.includes('cursor=') ? { contract_version: 1, items: [], next_cursor: 'c1', has_more: false } : { contract_version: 1, items: [bad], next_cursor: 'c1', has_more: false });
  };
  const report = await runVendorCheck({ baseUrl: 'http://example.test', vendor: 'lama', key: 'hwo_x', fetchImpl, wait: noWait });
  const check = report.checks.find((c) => c.name === 'every record matches the contract');
  assert.equal(check.passed, false);
  assert.match(check.detail, /page 1 item 0\.title is not part of this vendor's contract/);
  assert.match(check.detail, /page 1 item 0\.created_at must be an ISO date-time/);
});

test('a server that never answers times out, with a capped number of attempts', async (t) => {
  let requests = 0;
  const hanging = createServer(() => { requests += 1; }); // accepts, never answers
  await new Promise((resolve) => hanging.listen(0, '127.0.0.1', resolve));
  t.after(() => { hanging.closeAllConnections(); return new Promise((resolve) => hanging.close(resolve)); });

  const started = Date.now();
  const report = await runVendorCheck({ baseUrl: `http://127.0.0.1:${hanging.address().port}`, vendor: 'lama', key: 'hwo_x', timeoutMs: 100, attempts: 2, wait: noWait });
  assert.equal(report.passed, false);
  assert.match(report.checks[0].detail, /no answer within 100 ms \(after 2 attempts\)/);
  assert.ok(Date.now() - started < 3000, 'gave up quickly');
  assert.equal(requests, 6, 'three calls, two attempts each, then stop');
});

test('attempts are capped at 5 whatever is asked for', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { status: 503, json: async () => ({}) }; };
  await runVendorCheck({ baseUrl: 'http://example.test', vendor: 'lama', key: 'hwo_x', attempts: 100, fetchImpl, wait: noWait });
  assert.equal(calls, 15, 'three calls, at most five attempts each');
});
