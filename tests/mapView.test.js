// STORY-016 step 1 — the map's data: placed where the heat map places it, checked against GIS.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../server/db.js';
import { createWorkOrder } from '../server/workOrders.js';
import { issueUserKey } from '../server/access.js';
import { createGisClient, createGisLogger, createStandInGis, loadStandInAssets } from '../server/gis.js';
import { submitPublicRequest } from '../server/publicRequests.js';
import { analyzeWorkOrders } from '../server/heatMaps.js';
import { mapPoints, withGisCheck } from '../server/mapView.js';
import { createApiServer } from '../server/api/server.js';
import { processGisChanges } from '../server/gisInbound.js';
import { approveRequest, approver } from './helpers/intake.js';

async function setup({ backend } = {}) {
  const db = openDatabase();
  const assets = createStandInGis(loadStandInAssets());
  const gis = createGisClient(backend ?? assets, { log: createGisLogger(db), timeoutMs: 150, attempts: 2, delayMs: 1 });
  // From a GIS asset: coordinates come from GIS (STORY-001/002).
  const fromAsset = await createWorkOrder(db, { title: 'Streetlight out', created_by: 'clerk', asset_ids: ['SL-0001'] }, { gis: createGisClient(assets, { log: () => {} }), now: () => '2026-11-02T09:00:00.000Z' });
  // Freeform only: no coordinates at all.
  const freeform = await createWorkOrder(db, { title: 'Graffiti behind the rec centre', work_type: 'graffiti', location_text: 'Behind the stand-in rec centre', created_by: 'clerk' }, { now: () => '2026-11-03T09:00:00.000Z' });
  // A citizen request with a map pin, approved through intake (STORY-015).
  const r = await submitPublicRequest(db, { description: 'Pothole in the right-hand lane', category: 'pothole', location_text: 'Stand-in Example Way', latitude: 40.5125, longitude: -112.0331, submission_id: 'map-pin-0001' }, { ip: '203.0.113.7', now: () => '2026-11-04T09:00:00.000Z' });
  const pinned = await approveRequest(db, r.tracking_code, { now: () => '2026-11-04T10:00:00.000Z' });
  return { db, gis, assets, fromAsset, freeform, pinned };
}

test('each work order with a location is plotted at its coordinates; one without is listed with the reason', async () => {
  const { db, fromAsset, freeform, pinned } = await setup();
  const map = mapPoints(db);
  const byId = Object.fromEntries(map.points.map((p) => [p.id, p]));
  assert.deepEqual([byId[fromAsset.id].lat, byId[fromAsset.id].lng, byId[fromAsset.id].position_from], [40.5141, -112.033, 'work order record']);
  assert.deepEqual([byId[pinned].lat, byId[pinned].lng, byId[pinned].position_from], [40.5125, -112.0331, 'citizen map pin']);
  assert.deepEqual(map.unplaced.map((u) => [u.id, u.location]), [[freeform.id, 'Behind the stand-in rec centre']]);
  assert.match(map.unplaced[0].reason, /No coordinates recorded/);
});

test('the map and the heat map always count the same work orders, for any filter', async () => {
  const { db } = await setup();
  for (const filters of [{}, { from: '2026-11-03' }, { to: '2026-11-03' }, { status: 'completed' }, { work_types: ['pothole', 'graffiti'] }]) {
    const map = mapPoints(db, filters);
    const heat = analyzeWorkOrders(db, filters);
    assert.deepEqual([map.total, map.points.length, map.unplaced.length], [heat.total_matching, heat.mapped, heat.unmapped], JSON.stringify(filters));
  }
});

test('a date range with no work orders is an empty result, not an error; bad filters are refused like the heat map refuses them', async () => {
  const { db } = await setup();
  const empty = mapPoints(db, { from: '2025-01-01', to: '2025-02-01' });
  assert.deepEqual([empty.empty, empty.total, empty.points, empty.unplaced], [true, 0, [], []]);
  assert.throws(() => mapPoints(db, { from: 'last week' }), /from must be/);
});

test('GIS confirms each linked work order\'s position; a moved asset is flagged, never silently moved', async () => {
  const { db, gis, assets, fromAsset } = await setup();
  const checked = await withGisCheck(mapPoints(db), gis);
  assert.equal(checked.gis_status, 'live');
  const point = (m) => m.points.find((p) => p.id === fromAsset.id);
  assert.equal(point(checked).gis_check, 'matches');
  assert.ok(checked.points.filter((p) => !p.asset_ids.length).every((p) => p.gis_check === 'not_linked'));

  assets.editAsset('SL-0001', { location: { lat: 40.6, lng: -112.1 } }); // GIS moved it; the sync has not run yet
  const moved = await withGisCheck(mapPoints(db), gis);
  assert.equal(point(moved).gis_check, 'differs');
  assert.deepEqual([point(moved).lat, point(moved).gis_location.lat], [40.5141, 40.6], 'shown where it is stored, with GIS\'s position alongside');

  await processGisChanges(db, gis); // the STORY-002 sync brings the stored record in line with GIS
  const synced = await withGisCheck(mapPoints(db), gis);
  assert.deepEqual([point(synced).lat, point(synced).gis_check], [40.6, 'matches']);
});

test('if GIS times out, the map says so and still shows every work order from the stored record', async () => {
  const healthy = createStandInGis(loadStandInAssets());
  let down = false;
  const flaky = { ...healthy, getAsset: (id, auth) => (down ? new Promise(() => {}) : healthy.getAsset(id, auth)) };
  const { db, gis } = await setup({ backend: flaky });
  down = true;
  const started = Date.now();
  const checked = await withGisCheck(mapPoints(db), gis);
  assert.equal(checked.gis_status, 'unavailable');
  assert.equal(checked.points.length + checked.unplaced.length, 3, 'nothing is dropped');
  assert.ok(checked.points.filter((p) => p.asset_ids.length).every((p) => p.gis_check === 'not_checked'));
  assert.ok(Date.now() - started < 3000, 'gave up quickly');
});

test('over HTTP the map needs a key, is audited with the number of points, and returns exactly what mapPoints gives', async (t) => {
  const { db, gis } = await setup();
  const adminId = approver(db); // the administrator the intake helper already created
  const key = issueUserKey(db, adminId, { actorUserId: adminId }).key;
  const server = createApiServer(db, { gis });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/console/map`;
  const res = await fetch(`${base}?from=2026-11-01&work_types=pothole,streetlight`, { headers: { Authorization: `Bearer ${key}` } });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body.points.map((p) => [p.id, p.lat, p.lng]), mapPoints(db, { from: '2026-11-01', work_types: ['pothole', 'streetlight'] }).points.map((p) => [p.id, p.lat, p.lng]));
  assert.equal(body.items, undefined);
  const read = db.prepare("SELECT after_json FROM audit_entries WHERE action = 'read' ORDER BY id DESC").get();
  assert.equal(JSON.parse(read.after_json).records_returned, body.points.length);
  assert.equal((await fetch(base)).status, 401);
});
