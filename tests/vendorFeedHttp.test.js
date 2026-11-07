// STORY-009 over real HTTP: Lama, SpryPoint and Madison AI each read their own one-way feed,
// shaped to their own contract, with every request logged.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../server/db.js';
import { createApiClient } from '../server/api/clients.js';
import { createApiServer } from '../server/api/server.js';
import { createWorkOrder, updateWorkOrder } from '../server/workOrders.js';
import { getContract } from '../server/vendors.js';
import { AUTOMATIC_CHECKS } from '../server/readiness.js';

async function start() {
  const db = openDatabase();
  const keys = {
    lama: createApiClient(db, { name: 'Lama', scopes: ['vendor_feed:lama'], actor: 'admin-1' }).key,
    sprypoint: createApiClient(db, { name: 'SpryPoint', scopes: ['vendor_feed:sprypoint'], actor: 'admin-1' }).key,
    madison_ai: createApiClient(db, { name: 'Madison AI', scopes: ['vendor_feed:madison_ai'], actor: 'admin-1' }).key,
  };
  const ids = [];
  for (let i = 1; i <= 5; i += 1) {
    const at = `2026-11-0${i}T09:00:00.000Z`;
    ids.push((await createWorkOrder(db, {
      title: `Leak ${i} - call Mrs Jones 801-555-0101`, work_type: 'water_leak', location_text: 'Front yard', created_by: 'clerk-1',
    }, { now: () => at })).id);
  }
  const server = createApiServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (method, path, key) => {
    const res = await fetch(`${base}${path}`, { method, headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(5000) });
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
  };
  const log = () => db.prepare('SELECT * FROM vendor_exchange_log ORDER BY id').all();
  return { db, keys, ids, call, log, stop: () => new Promise((resolve) => server.close(resolve)) };
}

test('the vendors and their contracts are published, without a key', async (t) => {
  const { call, stop } = await start();
  t.after(stop);
  const res = await call('GET', '/vendors');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.items.map((v) => [v.key, v.contracts[0].status]), [['madison_ai', 'agreed'], ['lama', 'proposed'], ['sprypoint', 'proposed']]);
});

// ---------- AC1 + AC2: data exchange works, and requests are processed correctly ----------

test('Lama reads its feed: its own fields only, no personal details, and the request is logged and audited', async (t) => {
  const { db, keys, call, log, stop } = await start();
  t.after(stop);
  const res = await call('GET', '/vendors/lama/feed', keys.lama);
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.vendor, res.body.contract_version, res.body.contract_status, res.body.items.length], ['lama', 1, 'proposed', 5]);
  for (const item of res.body.items) assert.deepEqual(Object.keys(item).sort(), [...getContract('lama').fields].sort());
  assert.doesNotMatch(JSON.stringify(res.body), /Jones|801-555|Front yard|clerk-1/);

  const [row] = log();
  assert.deepEqual([row.vendor, row.client_name, row.contract_version, row.records_returned, row.outcome], ['lama', 'Lama', 1, 5, 'ok']);
  assert.equal(row.request_id, res.headers.get('x-request-id'), 'linked to the request log');
  assert.ok(!Number.isNaN(Date.parse(row.started_at)) && !Number.isNaN(Date.parse(row.finished_at)));
  const audit = db.prepare("SELECT after_json FROM audit_entries WHERE entity_type = 'api_access' AND action = 'read'").get();
  assert.equal(JSON.parse(audit.after_json).records_returned, 5);
});

test('Madison AI reads its feed in the full format it already indexes', async (t) => {
  const { keys, call, stop } = await start();
  t.after(stop);
  const res = await call('GET', '/vendors/madison_ai/feed?limit=1', keys.madison_ai);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body.items[0]).sort(), [...getContract('madison_ai').fields].sort());
  assert.match(res.body.items[0].title, /Leak 1/);
});

test('pages never skip or repeat, and a vendor that keeps its cursor picks up only what changed', async (t) => {
  const { db, keys, ids, call, stop } = await start();
  t.after(stop);
  const seen = [];
  let cursor = '';
  let last;
  do {
    last = await call('GET', `/vendors/sprypoint/feed?limit=2${cursor ? `&cursor=${cursor}` : ''}`, keys.sprypoint);
    seen.push(...last.body.items.map((i) => i.id));
    cursor = last.body.next_cursor; // always given, so the vendor can save it
  } while (last.body.has_more);
  assert.deepEqual(seen, ids, 'all five, oldest change first, once each');
  const nothingNew = await call('GET', `/vendors/sprypoint/feed?cursor=${cursor}`, keys.sprypoint);
  assert.deepEqual([nothingNew.body.items, nothingNew.body.next_cursor, nothingNew.body.has_more], [[], cursor, false], 'nothing new: same position back');

  await updateWorkOrder(db, ids[1], { priority: 'high' }, { actor: 'crew-1', now: () => '2026-11-06T09:00:00.000Z' });
  const resumed = await call('GET', `/vendors/sprypoint/feed?cursor=${cursor}`, keys.sprypoint);
  assert.deepEqual(resumed.body.items.map((i) => [i.id, i.priority]), [[ids[1], 'high']], 'only the change since the last read');

  const since = await call('GET', '/vendors/sprypoint/feed?since=2026-11-03T12:00:00Z', keys.sprypoint);
  assert.deepEqual(since.body.items.map((i) => i.id), [ids[3], ids[4], ids[1]]);
});

// ---------- failure paths: unauthorized access, data mismatch, vendor request problems ----------

test('a vendor cannot read another vendor\'s feed; refusals are logged and audited', async (t) => {
  const { db, keys, call, log, stop } = await start();
  t.after(stop);
  assert.equal((await call('GET', '/vendors/sprypoint/feed', keys.lama)).status, 403);
  assert.equal((await call('GET', '/vendors/madison_ai/feed', keys.lama)).status, 403);
  assert.equal((await call('GET', '/vendors/lama/feed')).status, 401);
  assert.deepEqual(log().map((r) => [r.vendor, r.client_name, r.outcome, r.records_returned]), [
    ['sprypoint', 'Lama', 'denied', 0], ['madison_ai', 'Lama', 'denied', 0], ['lama', 'anonymous', 'denied', 0],
  ]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_entries WHERE action = 'denied'").get().n, 3);
});

test('bad requests are refused with every problem listed, and logged as invalid', async (t) => {
  const { keys, call, log, stop } = await start();
  t.after(stop);
  const bad = await call('GET', '/vendors/lama/feed?since=yesterday&limit=500&colour=red', keys.lama);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.problems.length, 3);
  const version = await call('GET', '/vendors/lama/feed?contract=2', keys.lama);
  assert.equal(version.status, 400);
  assert.match(version.body.problems[0], /available: 1/);
  assert.equal((await call('GET', '/vendors/scada/feed', keys.lama)).status, 404);
  assert.equal((await call('POST', '/vendors/lama/feed', keys.lama)).status, 405, 'one-way: vendors cannot send data');
  assert.deepEqual(log().map((r) => r.outcome), ['invalid', 'invalid', 'invalid']);
});

test('data that does not match the contract is never sent: 500, nothing in the response, logged as a mismatch', async (t) => {
  const { db, keys, ids, call, log, stop } = await start();
  t.after(stop);
  db.prepare("UPDATE work_orders SET created_at = 'not a date' WHERE id = ?").run(ids[2]);
  const res = await call('GET', '/vendors/lama/feed', keys.lama);
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'contract_mismatch');
  assert.equal(res.body.items, undefined);
  const [row] = log();
  assert.deepEqual([row.outcome, row.records_returned], ['mismatch', 0]);
  assert.match(row.error, /created_at must be an ISO date-time/);
});

test('if the request cannot be logged, nothing is sent', async (t) => {
  const { db, keys, call, stop } = await start();
  t.after(stop);
  db.exec("CREATE TRIGGER no_log BEFORE INSERT ON vendor_exchange_log BEGIN SELECT RAISE(ABORT, 'disk full'); END;");
  const res = await call('GET', '/vendors/lama/feed', keys.lama);
  assert.equal(res.status, 503);
  assert.equal(res.body.items, undefined);
});

test('a successful exchange is what the readiness assessment counts as integrated', async (t) => {
  const { db, keys, call, stop } = await start();
  t.after(stop);
  const at = new Date().toISOString();
  assert.equal((await AUTOMATIC_CHECKS['testing.vendor_lama'].run(db, at)).passed, false, 'registered but no exchange yet');
  await call('GET', '/vendors/lama/feed', keys.lama);
  const check = await AUTOMATIC_CHECKS['testing.vendor_lama'].run(db, new Date().toISOString());
  assert.equal(check.passed, true);
  assert.match(check.detail, /Lama exchanged data successfully/);
});
