// STORY-002 — read from and write to GIS.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../server/db.js';
import { createWorkOrder, updateWorkOrder, completeWorkOrder, getWorkOrder } from '../server/workOrders.js';
import { processGisChanges, readCursor, GIS_ACTOR } from '../server/gisInbound.js';
import {
  createGisClient, createGisLogger, createStandInGis, loadStandInAssets, gisTokenFromEnv,
} from '../server/gis.js';

const logRows = (db) => db.prepare('SELECT * FROM gis_log ORDER BY id').all();

// ---------- AC3: every GIS interaction is logged with timestamps ----------

test('a successful GIS call is logged with its operation, asset, outcome and timestamps', async () => {
  const db = openDatabase();
  const gis = createGisClient(createStandInGis(loadStandInAssets()), { log: createGisLogger(db), attempts: 1 });
  await gis.getAsset('SL-0001');

  const [row] = logRows(db);
  assert.equal(row.operation, 'getAsset');
  assert.equal(row.asset_id, 'SL-0001');
  assert.equal(row.attempt, 1);
  assert.equal(row.outcome, 'ok');
  assert.equal(row.error, null);
  assert.ok(Date.parse(row.started_at) <= Date.parse(row.finished_at));
  assert.ok(row.duration_ms >= 0);
});

test('a failing GIS call is logged once per attempt, so retries keep their history', async () => {
  const db = openDatabase();
  let calls = 0;
  const flaky = {
    getAsset: async () => { calls += 1; if (calls === 1) throw new Error('connection reset'); return { id: 'SL-0001' }; },
    linkWorkOrder: async () => ({}),
  };
  const gis = createGisClient(flaky, { log: createGisLogger(db), attempts: 3, delayMs: 1 });
  await gis.getAsset('SL-0001');

  const rows = logRows(db);
  assert.deepEqual(rows.map((r) => [r.attempt, r.outcome]), [[1, 'error'], [2, 'ok']]);
  assert.equal(rows[0].error, 'connection reset');
});

test('a GIS call that times out is logged with outcome "timeout"', async () => {
  const db = openDatabase();
  const hang = { getAsset: () => new Promise(() => {}), linkWorkOrder: () => new Promise(() => {}) };
  const gis = createGisClient(hang, { log: createGisLogger(db), timeoutMs: 20, attempts: 2, delayMs: 1 });
  await assert.rejects(gis.linkWorkOrder('SL-0001', { work_order_id: 'x' }), /timed out/);

  const rows = logRows(db);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.outcome === 'timeout' && r.operation === 'linkWorkOrder'));
});

test('a GIS client cannot be created without a log', () => {
  assert.throws(() => createGisClient(createStandInGis([]), {}), /needs a log function/);
});

// ---------- failure path: unauthorized access ----------

// Generated per test run, so no credential is ever written into the repo.
const TOKEN = `test-${crypto.randomUUID()}`;

function securedGis(db, token) {
  const backend = createStandInGis(loadStandInAssets(), { requireToken: TOKEN });
  return createGisClient(backend, { log: createGisLogger(db), token, attempts: 3, delayMs: 1 });
}

test('the correct GIS credential is accepted', async () => {
  const db = openDatabase();
  const asset = await securedGis(db, TOKEN).getAsset('SL-0001');
  assert.equal(asset.id, 'SL-0001');
  assert.equal(logRows(db)[0].outcome, 'ok');
});

test('a wrong or missing credential is refused after one attempt and logged as unauthorized', async () => {
  for (const token of ['wrong-token', null]) {
    const db = openDatabase();
    await assert.rejects(securedGis(db, token).getAsset('SL-0001'), (err) => err.code === 'unauthorized');
    const rows = logRows(db);
    assert.equal(rows.length, 1, 'an unauthorized call is not retried');
    assert.equal(rows[0].outcome, 'unauthorized');
  }
});

test('the credential never appears in the GIS log', async () => {
  const db = openDatabase();
  const gis = securedGis(db, TOKEN);
  await gis.getAsset('SL-0001');
  await gis.linkWorkOrder('SL-0001', { work_order_id: 'wo-1' });
  await assert.rejects(securedGis(db, 'wrong-token').getAsset('SL-0001'));
  const everything = JSON.stringify(logRows(db));
  assert.doesNotMatch(everything, new RegExp(TOKEN));
  assert.doesNotMatch(everything, /wrong-token/);
});

test('the GIS credential is read from GIS_TOKEN and its absence is a clear error', () => {
  assert.equal(gisTokenFromEnv({ GIS_TOKEN: ' abc ' }), 'abc');
  assert.throws(() => gisTokenFromEnv({}), /GIS_TOKEN is not set/);
});

// ---------- AC2: a GIS update, when processed, is reflected in the work order ----------

async function linkedSetup(assetIds = ['SL-0001']) {
  const db = openDatabase();
  const backend = createStandInGis(loadStandInAssets());
  const gis = createGisClient(backend, { log: createGisLogger(db), timeoutMs: 200, attempts: 2, delayMs: 1 });
  const wo = await createWorkOrder(db, { title: 'Light out', asset_ids: assetIds, created_by: 'user-1' }, { gis });
  return { db, backend, gis, wo };
}

const gisAudits = (db, id) => db.prepare("SELECT * FROM audit_entries WHERE entity_id = ? AND action = 'gis_update' ORDER BY id").all(id);

test('AC2: an address and location edited in GIS is reflected in the work order, and audited', async () => {
  const { db, backend, gis, wo } = await linkedSetup();
  backend.editAsset('SL-0001', { address: 'Stand-in address: 102 Example Way', location: { lat: 40.5150, lng: -112.0310 } });

  const result = await processGisChanges(db, gis);
  assert.equal(result.failed, null);
  assert.deepEqual(result.outcomes.map((o) => o.result), ['updated']);

  const after = getWorkOrder(db, wo.id);
  assert.equal(after.address, 'Stand-in address: 102 Example Way');
  assert.equal(after.latitude, 40.515);
  assert.equal(after.longitude, -112.031);
  assert.equal(after.title, 'Light out', 'GIS never touches work order fields');

  const [audit] = gisAudits(db, wo.id);
  assert.equal(audit.actor, GIS_ACTOR);
  assert.match(JSON.parse(audit.before_json).address, /100 Example Way/);
  assert.match(JSON.parse(audit.after_json).address, /102 Example Way/);
});

test('an attribute edited in GIS updates the asset snapshot on the work order', async () => {
  const { db, backend, gis, wo } = await linkedSetup();
  backend.editAsset('SL-0001', { attributes: { pole_height_ft: 35, lamp: 'LED', circuit: 'C-14' } });
  await processGisChanges(db, gis);
  const snap = db.prepare('SELECT attributes_json FROM work_order_assets WHERE work_order_id = ?').get(wo.id);
  assert.equal(JSON.parse(snap.attributes_json).circuit, 'C-14');
});

test('processing again applies nothing twice', async () => {
  const { db, backend, gis, wo } = await linkedSetup();
  backend.editAsset('SL-0001', { address: 'Stand-in address: 104 Example Way' });
  await processGisChanges(db, gis);
  const second = await processGisChanges(db, gis);
  assert.equal(second.outcomes.length, 0);
  assert.equal(gisAudits(db, wo.id).length, 1);
});

test('a change GIS sends again after the cursor was reset is recognised as unchanged, not re-audited', async () => {
  const { db, backend, gis, wo } = await linkedSetup();
  backend.editAsset('SL-0001', { address: 'Stand-in address: 106 Example Way' });
  await processGisChanges(db, gis);
  db.prepare('UPDATE gis_cursor SET value = 0').run(); // simulate GIS re-delivering old changes
  const again = await processGisChanges(db, gis);
  assert.deepEqual(again.outcomes.map((o) => o.result), ['unchanged']);
  assert.equal(gisAudits(db, wo.id).length, 1);
});

test('a GIS change to a secondary asset updates its snapshot but not the work order location', async () => {
  const { db, backend, gis, wo } = await linkedSetup(['SL-0001', 'SL-0002']);
  backend.editAsset('SL-0002', { address: 'Stand-in address: 999 Elsewhere', attributes: { lamp: 'HPS' } });
  await processGisChanges(db, gis);
  assert.match(getWorkOrder(db, wo.id).address, /100 Example Way/);
  const snap = db.prepare("SELECT attributes_json FROM work_order_assets WHERE work_order_id = ? AND asset_id = 'SL-0002'").get(wo.id);
  assert.equal(JSON.parse(snap.attributes_json).lamp, 'HPS');
});

test('a completed work order is left untouched by GIS changes, and the skip is reported', async () => {
  const { db, backend, gis, wo } = await linkedSetup();
  await completeWorkOrder(db, wo.id, { note: 'Fixed', actor: 'crew-7', gis });
  backend.editAsset('SL-0001', { address: 'Stand-in address: 108 Example Way' });

  const result = await processGisChanges(db, gis);
  assert.deepEqual(result.outcomes.map((o) => o.result), ['skipped']);
  assert.match(getWorkOrder(db, wo.id).address, /100 Example Way/);
  assert.equal(gisAudits(db, wo.id).length, 0);
  assert.equal(readCursor(db), result.cursor, 'the change is still marked as processed');
});

// ---------- failure paths: connection lost, data sync fails ----------

test('if the GIS connection is lost, nothing is applied and the next run picks up the change', async () => {
  const { db, backend, wo } = await linkedSetup();
  backend.editAsset('SL-0001', { address: 'Stand-in address: 110 Example Way' });
  let connected = false;
  const dropping = {
    getChangesSince: (c, auth) => (connected ? backend.getChangesSince(c, auth) : Promise.reject(new Error('connection lost'))),
    getAsset: (id, auth) => backend.getAsset(id, auth),
    linkWorkOrder: (id, l, auth) => backend.linkWorkOrder(id, l, auth),
  };
  const gis = createGisClient(dropping, { log: createGisLogger(db), timeoutMs: 200, attempts: 2, delayMs: 1 });

  await assert.rejects(processGisChanges(db, gis), /connection lost/);
  assert.equal(readCursor(db), 0);
  assert.match(getWorkOrder(db, wo.id).address, /100 Example Way/);
  const lost = db.prepare("SELECT outcome FROM gis_log WHERE operation = 'getChangesSince'").all();
  assert.deepEqual(lost.map((r) => r.outcome), ['error', 'error'], 'both attempts are logged');

  connected = true;
  await processGisChanges(db, gis);
  assert.match(getWorkOrder(db, wo.id).address, /110 Example Way/);
});

test('if applying a GIS change fails, it is rolled back, reported, and applied on the next run', async () => {
  const { db, backend, gis, wo } = await linkedSetup();
  backend.editAsset('SL-0001', { address: 'Stand-in address: 112 Example Way' });
  backend.editAsset('SL-0001', { address: 'Stand-in address: 114 Example Way' });

  const failingAudit = () => { throw new Error('audit store unavailable'); };
  const bad = await processGisChanges(db, gis, { audit: failingAudit });
  assert.equal(bad.failed.seq, 1);
  assert.match(bad.failed.error, /audit store unavailable/);
  assert.equal(readCursor(db), 0, 'the cursor did not move past the failed change');
  assert.match(getWorkOrder(db, wo.id).address, /100 Example Way/, 'no half-applied change');

  const good = await processGisChanges(db, gis);
  assert.equal(good.failed, null);
  assert.equal(good.cursor, 2);
  assert.match(getWorkOrder(db, wo.id).address, /114 Example Way/);
  assert.equal(gisAudits(db, wo.id).length, 2);
});

// ---------- AC1: a work order update, when saved, is reflected in the GIS database ----------

test('AC1: a saved work order update is reflected in GIS, and that write is logged with timestamps', async () => {
  const { db, backend, gis, wo } = await linkedSetup();
  const logBefore = db.prepare('SELECT COUNT(*) AS n FROM gis_log').get().n;

  const saved = await updateWorkOrder(db, wo.id, { priority: 'urgent', title: 'Light out — wires exposed' }, { actor: 'user-2', gis });

  const link = (await backend.getAsset('SL-0001')).linked_work_orders.find((l) => l.work_order_id === wo.id);
  assert.equal(link.priority, 'urgent');
  assert.equal(link.title, 'Light out — wires exposed');
  assert.equal(link.updated_at, saved.updated_at);
  assert.equal(saved.gis_sync, 'synced');

  const writes = db.prepare("SELECT * FROM gis_log WHERE id > ? AND operation = 'linkWorkOrder'").all(logBefore);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].asset_id, 'SL-0001');
  assert.equal(writes[0].outcome, 'ok');
  assert.ok(!Number.isNaN(Date.parse(writes[0].started_at)) && !Number.isNaN(Date.parse(writes[0].finished_at)));
});
