// STORY-004 — "data mismatch": a stale update is refused instead of overwriting someone else's change.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../server/db.js';
import {
  createWorkOrder, updateWorkOrder, completeWorkOrder, getWorkOrder, VersionConflictError, ConflictError, ValidationError,
} from '../server/workOrders.js';
import { publishWorkOrder } from '../server/publicRequests.js';
import { processGisChanges } from '../server/gisInbound.js';
import { createGisClient, createGisLogger, createStandInGis, loadStandInAssets } from '../server/gis.js';

const version = (db, id) => getWorkOrder(db, id).version;

async function workOrder(db, extra = {}) {
  return createWorkOrder(db, { title: 'Pothole', work_type: 'pothole', location_text: 'Stand-in site', created_by: 'user-1', ...extra }, extra.gis ? { gis: extra.gis } : {});
}

test('a new work order starts at version 1, and every kind of change adds 1', async () => {
  const db = openDatabase();
  const backend = createStandInGis(loadStandInAssets());
  const gis = createGisClient(backend, { log: createGisLogger(db), timeoutMs: 200, attempts: 1 });
  const wo = await createWorkOrder(db, { title: 'Light out', asset_ids: ['SL-0001'], created_by: 'user-1' }, { gis });
  assert.equal(wo.version, 1);

  await updateWorkOrder(db, wo.id, { priority: 'high' }, { actor: 'user-2', gis });
  assert.equal(version(db, wo.id), 2, 'update');

  publishWorkOrder(db, wo.id, { actor: 'staff' });
  assert.equal(version(db, wo.id), 3, 'publish');

  backend.editAsset('SL-0001', { address: 'Stand-in address: 102 Example Way' });
  await processGisChanges(db, gis);
  assert.equal(version(db, wo.id), 4, 'change from GIS');

  await completeWorkOrder(db, wo.id, { note: 'Fixed', actor: 'crew', gis });
  assert.equal(version(db, wo.id), 5, 'complete');
});

test('an update that changes nothing does not change the version', async () => {
  const db = openDatabase();
  const wo = await workOrder(db);
  await updateWorkOrder(db, wo.id, { priority: 'normal' }, { actor: 'user-2' });
  assert.equal(version(db, wo.id), 1);
});

test('an update with the current version is accepted', async () => {
  const db = openDatabase();
  const wo = await workOrder(db);
  const updated = await updateWorkOrder(db, wo.id, { priority: 'high' }, { actor: 'user-2', expectedVersion: 1 });
  assert.equal(updated.priority, 'high');
  assert.equal(updated.version, 2);
});

test('a stale update is refused, nothing changes, and the conflict says what the current version is', async () => {
  const db = openDatabase();
  const wo = await workOrder(db);
  await updateWorkOrder(db, wo.id, { title: 'Pothole — getting worse' }, { actor: 'dispatcher' }); // someone else, now version 2

  await assert.rejects(updateWorkOrder(db, wo.id, { title: 'Pothole — fixed?' }, { actor: 'outside-system', expectedVersion: 1 }), (err) => {
    assert.ok(err instanceof VersionConflictError);
    assert.ok(err instanceof ConflictError, 'existing callers that handle ConflictError still work');
    assert.equal(err.expectedVersion, 1);
    assert.equal(err.currentVersion, 2);
    assert.match(err.message, /changed since you read it/);
    return true;
  });
  assert.equal(getWorkOrder(db, wo.id).title, 'Pothole — getting worse', "the other person's change was not overwritten");
  assert.equal(version(db, wo.id), 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_entries WHERE entity_id = ? AND actor = 'outside-system'").get(wo.id).n, 0);
});

test('a stale completion is refused the same way', async () => {
  const db = openDatabase();
  const wo = await workOrder(db);
  await updateWorkOrder(db, wo.id, { priority: 'high' }, { actor: 'dispatcher' });
  await assert.rejects(completeWorkOrder(db, wo.id, { note: 'Done', actor: 'crew', expectedVersion: 1 }), VersionConflictError);
  assert.equal(getWorkOrder(db, wo.id).status, 'open');
  const done = await completeWorkOrder(db, wo.id, { note: 'Done', actor: 'crew', expectedVersion: 2 });
  assert.equal(done.status, 'completed');
});

test('a malformed expected version is refused', async () => {
  const db = openDatabase();
  const wo = await workOrder(db);
  for (const bad of [0, -1, 1.5, '1', null]) {
    await assert.rejects(updateWorkOrder(db, wo.id, { priority: 'high' }, { actor: 'x', expectedVersion: bad }), ValidationError, String(bad));
  }
  assert.equal(version(db, wo.id), 1);
});

test('callers that do not send a version keep working exactly as before', async () => {
  const db = openDatabase();
  const wo = await workOrder(db);
  await updateWorkOrder(db, wo.id, { priority: 'high' }, { actor: 'a' });
  await updateWorkOrder(db, wo.id, { priority: 'low' }, { actor: 'b' });
  assert.equal(getWorkOrder(db, wo.id).priority, 'low');
});
