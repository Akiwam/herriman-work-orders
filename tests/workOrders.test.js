import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../server/db.js';
import {
  createWorkOrder, updateWorkOrder, completeWorkOrder, getWorkOrder, syncPending,
  ValidationError, NotFoundError, ConflictError,
} from '../server/workOrders.js';
import {
  createStandInGis, createGisClient, loadStandInAssets, withTimeout, withRetry, GisError,
} from '../server/gis.js';

const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

/** A stand-in GIS wrapped the way production code uses it, with fast retries for tests. */
function standInGis() {
  const backend = createStandInGis(loadStandInAssets());
  return { backend, gis: createGisClient(backend, { timeoutMs: 200, attempts: 2, delayMs: 1 }) };
}

function seed(db) {
  return createWorkOrder(db, {
    title: 'Broken streetlight', work_type: 'streetlight', location_text: 'Example Way', created_by: 'user-1',
  });
}

// ---------- create ----------

test('creating a work order saves it and writes exactly one audit entry', async () => {
  const db = openDatabase();
  const wo = await createWorkOrder(db, {
    title: 'Pothole on Main St', work_type: 'pothole', location_text: 'Main St near 12600 S', created_by: 'user-1',
  });

  assert.equal(wo.title, 'Pothole on Main St');
  assert.equal(wo.status, 'open');
  assert.equal(count(db, 'work_orders'), 1);

  const audits = db.prepare('SELECT * FROM audit_entries WHERE entity_id = ?').all(wo.id);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'create');
  assert.equal(audits[0].actor, 'user-1');
  assert.equal(JSON.parse(audits[0].after_json).title, 'Pothole on Main St');
});

test('a work order with missing required data is rejected and nothing is saved', async () => {
  const db = openDatabase();
  await assert.rejects(
    createWorkOrder(db, { title: '   ', created_by: 'user-1' }),
    (err) => err instanceof ValidationError
      && err.problems.includes('title is required')
      && err.problems.includes('work_type is required')
      && err.problems.some((p) => p.startsWith('a location is required')),
  );
  assert.equal(count(db, 'work_orders'), 0);
  assert.equal(count(db, 'audit_entries'), 0);
});

test('AC1: a new work order with a GIS asset appears with GIS data autofilled', async () => {
  const db = openDatabase();
  const { gis, backend } = standInGis();
  const wo = await createWorkOrder(db, { title: 'Light out', asset_ids: ['SL-0001'], created_by: 'user-1' }, { gis });

  // autofilled from GIS (REQ-023): work type, address, coordinates, asset snapshot
  assert.equal(wo.work_type, 'streetlight');
  assert.match(wo.address, /100 Example Way/);
  assert.equal(wo.latitude, 40.5141);
  assert.equal(wo.longitude, -112.033);
  assert.equal(wo.assets.length, 1);
  assert.equal(wo.assets[0].asset_id, 'SL-0001');
  assert.equal(wo.assets[0].attributes.lamp, 'LED');

  // and the GIS now knows about the work order (bidirectional)
  assert.equal(wo.gis_sync, 'synced');
  const asset = await backend.getAsset('SL-0001');
  assert.equal(asset.linked_work_orders.length, 1);
  assert.equal(asset.linked_work_orders[0].work_order_id, wo.id);
  assert.equal(count(db, 'audit_entries'), 1);
});

test('REQ-032: a freeform location is enough when GIS has no asset for the place', async () => {
  const db = openDatabase();
  const wo = await createWorkOrder(db, {
    title: 'Graffiti on fence', work_type: 'graffiti', location_text: 'Behind the stand-in rec centre', created_by: 'user-1',
  });
  assert.equal(wo.location_text, 'Behind the stand-in rec centre');
  assert.equal(wo.gis_sync, 'none');
});

test('selecting an asset that GIS does not have is rejected and nothing is saved', async () => {
  const db = openDatabase();
  const { gis } = standInGis();
  await assert.rejects(
    createWorkOrder(db, { title: 'x', asset_ids: ['NOPE-1'], created_by: 'user-1' }, { gis }),
    (err) => err instanceof ValidationError && err.problems.includes('asset NOPE-1 is not in GIS'),
  );
  assert.equal(count(db, 'work_orders'), 0);
  assert.equal(count(db, 'audit_entries'), 0);
});

// ---------- update ----------

test('updating a work order saves the change and audits the before and after values', async () => {
  const db = openDatabase();
  const wo = await seed(db);
  const updated = await updateWorkOrder(db, wo.id, { priority: 'high', location_text: 'Corner of Main and 6000 W' }, { actor: 'user-2' });

  assert.equal(updated.priority, 'high');
  assert.equal(getWorkOrder(db, wo.id).location_text, 'Corner of Main and 6000 W');

  const audits = db.prepare("SELECT * FROM audit_entries WHERE entity_id = ? AND action = 'update'").all(wo.id);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor, 'user-2');
  assert.equal(JSON.parse(audits[0].before_json).priority, 'normal');
  assert.equal(JSON.parse(audits[0].after_json).priority, 'high');
});

test('AC2: updating a linked work order saves the change and it is reflected in GIS', async () => {
  const db = openDatabase();
  const { gis, backend } = standInGis();
  const wo = await createWorkOrder(db, { title: 'Light out', asset_ids: ['SL-0001'], created_by: 'user-1' }, { gis });
  const updated = await updateWorkOrder(db, wo.id, { title: 'Light out — pole damaged', priority: 'high' }, { actor: 'user-2', gis });

  assert.equal(getWorkOrder(db, wo.id).priority, 'high');
  assert.equal(updated.gis_sync, 'synced');
  const link = (await backend.getAsset('SL-0001')).linked_work_orders[0];
  assert.equal(link.title, 'Light out — pole damaged');
  assert.equal(link.priority, 'high');
  assert.equal(link.updated_at, updated.updated_at);
});

test('updating a work order that does not exist is rejected and writes no audit entry', async () => {
  const db = openDatabase();
  await assert.rejects(updateWorkOrder(db, 'no-such-id', { priority: 'high' }, { actor: 'user-2' }), NotFoundError);
  assert.equal(count(db, 'audit_entries'), 0);
});

test('if the audit entry cannot be written, the update is rolled back', async () => {
  const db = openDatabase();
  const wo = await seed(db);
  const failingAudit = () => { throw new Error('audit store unavailable'); };

  await assert.rejects(
    updateWorkOrder(db, wo.id, { priority: 'high' }, { actor: 'user-2', audit: failingAudit }),
    /audit store unavailable/,
  );
  assert.equal(getWorkOrder(db, wo.id).priority, 'normal', 'the change must not survive without its audit entry');
  assert.equal(count(db, 'audit_entries'), 1, 'only the original create entry exists');
});

test('an update that clears a required field or touches a protected field is rejected', async () => {
  const db = openDatabase();
  const wo = await seed(db);
  await assert.rejects(updateWorkOrder(db, wo.id, { title: '' }, { actor: 'user-2' }), ValidationError);
  await assert.rejects(updateWorkOrder(db, wo.id, { status: 'completed' }, { actor: 'user-2' }), ValidationError);
  await assert.rejects(updateWorkOrder(db, wo.id, { priority: 'high' }, {}), ValidationError);
  await assert.rejects(updateWorkOrder(db, wo.id, { location_text: '' }, { actor: 'user-2' }), ValidationError);
  assert.equal(getWorkOrder(db, wo.id).title, 'Broken streetlight');
  assert.equal(count(db, 'audit_entries'), 1);
});

// ---------- GIS failure paths ----------

test('if GIS fails to update, the work order is still saved, the sync is marked failed, and a retry fixes it', async () => {
  const db = openDatabase();
  const { backend } = standInGis();
  let gisDown = true;
  const flaky = {
    kind: 'stand-in',
    getAsset: (id) => backend.getAsset(id),
    linkWorkOrder: (assetId, link) => (gisDown ? Promise.reject(new Error('GIS unavailable')) : backend.linkWorkOrder(assetId, link)),
  };
  const gis = createGisClient(flaky, { timeoutMs: 200, attempts: 2, delayMs: 1 });

  const wo = await createWorkOrder(db, { title: 'Hydrant leaking', asset_ids: ['HY-0101'], created_by: 'user-1' }, { gis });
  assert.equal(count(db, 'work_orders'), 1, 'the work order is not lost when GIS is down');
  assert.equal(wo.gis_sync, 'pending');
  assert.deepEqual(wo.gis_failures, [{ asset_id: 'HY-0101', error: 'GIS unavailable' }]);
  const row = db.prepare('SELECT * FROM gis_sync WHERE work_order_id = ?').get(wo.id);
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, 1);
  assert.equal((await backend.getAsset('HY-0101')).linked_work_orders.length, 0);

  gisDown = false;
  assert.deepEqual(await syncPending(db, gis, wo.id), []);
  assert.equal(db.prepare('SELECT status FROM gis_sync WHERE work_order_id = ?').get(wo.id).status, 'done');
  assert.equal((await backend.getAsset('HY-0101')).linked_work_orders[0].work_order_id, wo.id);
});

test('if GIS cannot be reached to look up an asset, creation fails cleanly and nothing is saved', async () => {
  const db = openDatabase();
  const down = { getAsset: () => Promise.reject(new GisError('connection refused')), linkWorkOrder: () => Promise.reject(new GisError('x')) };
  const gis = createGisClient(down, { timeoutMs: 100, attempts: 2, delayMs: 1 });
  await assert.rejects(createWorkOrder(db, { title: 'x', asset_ids: ['SL-0001'], created_by: 'user-1' }, { gis }), GisError);
  assert.equal(count(db, 'work_orders'), 0);
  assert.equal(count(db, 'audit_entries'), 0);
});

test('every GIS call has a timeout and a capped number of retries', async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 20, 'slow call'), /slow call timed out after 20 ms/);
  let calls = 0;
  await assert.rejects(withRetry(() => { calls += 1; throw new Error('nope'); }, { attempts: 3, delayMs: 1 }), /nope/);
  assert.equal(calls, 3);
});

test('pushing the same work order to GIS twice does not create a duplicate link', async () => {
  const db = openDatabase();
  const { gis, backend } = standInGis();
  const wo = await createWorkOrder(db, { title: 'Light out', asset_ids: ['SL-0002'], created_by: 'user-1' }, { gis });
  db.prepare("UPDATE gis_sync SET status = 'pending' WHERE work_order_id = ?").run(wo.id); // force a re-push
  await syncPending(db, gis, wo.id);
  assert.equal((await backend.getAsset('SL-0002')).linked_work_orders.length, 1);
});

// ---------- complete ----------

test('completing a work order records the note and time, audits it, and reflects it in GIS', async () => {
  const db = openDatabase();
  const { gis, backend } = standInGis();
  const wo = await createWorkOrder(db, { title: 'Light out', asset_ids: ['SL-0001'], created_by: 'user-1' }, { gis });
  const done = await completeWorkOrder(db, wo.id, { note: 'Replaced LED head', actor: 'crew-7', gis });

  assert.equal(done.status, 'completed');
  assert.equal(done.completion_note, 'Replaced LED head');
  assert.ok(done.completed_at);
  const audit = db.prepare("SELECT * FROM audit_entries WHERE entity_id = ? AND action = 'complete'").get(wo.id);
  assert.equal(audit.actor, 'crew-7');
  assert.equal(JSON.parse(audit.before_json).status, 'open');
  assert.equal(JSON.parse(audit.after_json).status, 'completed');
  assert.equal((await backend.getAsset('SL-0001')).linked_work_orders[0].status, 'completed');
});

test('a work order cannot be completed without a note, or completed twice, or changed after completion', async () => {
  const db = openDatabase();
  const wo = await seed(db);
  await assert.rejects(completeWorkOrder(db, wo.id, { note: '  ', actor: 'crew-7' }),
    (err) => err instanceof ValidationError && err.problems.includes('a completion note is required'));
  assert.equal(getWorkOrder(db, wo.id).status, 'open');

  await completeWorkOrder(db, wo.id, { note: 'Done', actor: 'crew-7' });
  await assert.rejects(completeWorkOrder(db, wo.id, { note: 'Again', actor: 'crew-7' }), ConflictError);
  await assert.rejects(updateWorkOrder(db, wo.id, { priority: 'high' }, { actor: 'user-2' }), ConflictError);
  await assert.rejects(completeWorkOrder(db, 'no-such-id', { note: 'x', actor: 'crew-7' }), NotFoundError);

  const actions = db.prepare('SELECT action FROM audit_entries WHERE entity_id = ? ORDER BY id').all(wo.id).map((r) => r.action);
  assert.deepEqual(actions, ['create', 'complete']);
});

// ---------- idempotent create ----------

test('sending the same create twice with a request_id makes one work order and one audit entry', async () => {
  const db = openDatabase();
  const { gis, backend } = standInGis();
  const input = { request_id: 'req-123', title: 'Light out', asset_ids: ['SL-0002'], created_by: 'user-1' };
  const first = await createWorkOrder(db, input, { gis });
  const second = await createWorkOrder(db, input, { gis });

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.id, first.id);
  assert.equal(count(db, 'work_orders'), 1);
  assert.equal(count(db, 'audit_entries'), 1);
  assert.equal((await backend.getAsset('SL-0002')).linked_work_orders.length, 1);
});

test('without a request_id, two creates are two separate work orders', async () => {
  const db = openDatabase();
  await seed(db);
  await seed(db);
  assert.equal(count(db, 'work_orders'), 2);
});
