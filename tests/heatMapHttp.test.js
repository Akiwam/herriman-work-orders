// STORY-005 over real HTTP: a planner requests heat maps.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../server/db.js';
import { createWorkOrder } from '../server/workOrders.js';
import { createApiClient, HEATMAPS_SCOPE } from '../server/api/clients.js';
import { createApiServer } from '../server/api/server.js';

async function workOrderAt(db, lat, lng, workType) {
  const wo = await createWorkOrder(db, { title: 'x', work_type: workType, location_text: 'Stand-in site', created_by: 'user-1' });
  if (lat !== null) db.prepare('UPDATE work_orders SET latitude = ?, longitude = ? WHERE id = ?').run(lat, lng, wo.id);
}

async function start() {
  const db = openDatabase();
  for (const [lat, lng] of [[40.51231, -112.03311], [40.51235, -112.03312], [40.51229, -112.03309]]) await workOrderAt(db, lat, lng, 'pothole');
  await workOrderAt(db, 40.52001, -112.04502, 'streetlight');
  await workOrderAt(db, null, null, 'graffiti');
  const planner = createApiClient(db, { name: 'Planning dept', scopes: [HEATMAPS_SCOPE], actor: 'admin-1' });
  const madison = createApiClient(db, { name: 'Madison AI', actor: 'admin-1' });
  const server = createApiServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/heat-maps`;
  const get = async (query = '', key = planner.key, method = 'GET') => {
    const res = await fetch(`${base}${query}`, { method, headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(5000) });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() };
  };
  const log = () => db.prepare('SELECT * FROM heat_map_log ORDER BY id').all();
  return { db, planner, madison, get, log, stop: () => new Promise((resolve) => server.close(resolve)) };
}

test('AC1 + AC2 over HTTP: GeoJSON heat map with the true counts, filtered by type', async (t) => {
  const { get, stop } = await start();
  t.after(stop);
  const all = await get();
  assert.equal(all.status, 200);
  assert.match(all.headers.get('content-type'), /^application\/geo\+json/);
  assert.deepEqual(all.body.features.map((f) => f.properties.count).sort(), [1, 3]);
  assert.deepEqual([all.body.properties.mapped, all.body.properties.unmapped], [4, 1]);

  const potholes = await get('?work_types=pothole');
  assert.deepEqual(potholes.body.features.map((f) => f.properties.count), [3]);
  const two = await get('?work_types=pothole,streetlight&status=open&cell_size_m=500');
  assert.equal(two.body.properties.total_matching, 4);
});

test('the SVG is served as a locked-down image', async (t) => {
  const { get, stop } = await start();
  t.after(stop);
  const svg = await get('?format=svg');
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get('content-type'), /^image\/svg\+xml/);
  assert.match(svg.headers.get('content-security-policy'), /default-src 'none'.*sandbox/);
  assert.equal(svg.headers.get('x-content-type-options'), 'nosniff');
  assert.match(svg.body, /^<svg /);
  assert.match(svg.body, /4 of 5 work orders mapped; 1 have no coordinates/);
});

test('AC3 over HTTP: each generation is logged under the calling system, with its parameters', async (t) => {
  const { get, log, stop } = await start();
  t.after(stop);
  await get('?format=svg&work_types=pothole&from=2026-01-01');
  await get('?cell_size_m=5');
  const rows = log();
  assert.deepEqual(rows.map((r) => [r.requested_by, r.format, r.outcome]), [['Planning dept', 'svg', 'ok'], ['Planning dept', 'geojson', 'invalid']]);
  const params = JSON.parse(rows[0].params_json);
  assert.deepEqual(params.work_types, ['pothole']);
  assert.equal(params.from, '2026-01-01T00:00:00.000Z');
});

test('unauthorized: no key 401, a key without heatmaps:read 403 — both audited, nothing generated', async (t) => {
  const { db, madison, get, log, stop } = await start();
  t.after(stop);
  assert.equal((await get('', null)).status, 401);
  assert.equal((await get('', madison.key)).status, 403);
  assert.equal(log().length, 0, 'no map was generated for a refused request');
  const denied = db.prepare("SELECT actor FROM audit_entries WHERE entity_type = 'api_access' AND action = 'denied' ORDER BY id").all().map((r) => r.actor);
  assert.deepEqual(denied, ['anonymous', 'Madison AI']);
});

test('bad parameters get 400, a map too detailed to draw gets 422 with advice, and only GET is allowed', async (t) => {
  const { db, get, stop } = await start();
  t.after(stop);
  const bad = await get('?status=maybe&colour=red&format=png');
  assert.equal(bad.status, 400);
  assert.ok(bad.body.problems.includes('format must be one of: geojson, svg'));

  // Spread the data ~32 km by ~28 km: with 50 m cells that is ~360,000 grid squares, over the 250,000 limit.
  db.prepare("UPDATE work_orders SET latitude = 40.80, longitude = -111.70 WHERE work_type = 'streetlight'").run();
  const detailed = await get('?cell_size_m=50&format=svg');
  assert.equal(detailed.status, 422);
  assert.equal(detailed.body.error, 'map_generation_error');
  assert.match(detailed.body.message, /larger cells/);
  assert.equal((await get('', undefined, 'POST')).status, 405);
});

test('the OpenAPI contract documents the heat map options from the same lists the code checks', async () => {
  const { openApiDocument } = await import('../server/api/openapi.js');
  const { FORMATS, STATUSES, CELL_SIZE } = await import('../server/heatMaps.js');
  const op = openApiDocument().paths['/heat-maps'].get;
  const param = (name) => op.parameters.find((p) => p.name === name).schema;
  assert.deepEqual(param('format').enum, FORMATS);
  assert.deepEqual(param('status').enum, STATUSES);
  assert.deepEqual([param('cell_size_m').minimum, param('cell_size_m').maximum], [CELL_SIZE.min, CELL_SIZE.max]);
  for (const code of ['400', '401', '403', '422']) assert.ok(op.responses[code], code);
});

test('if the database is down, a planner gets 503, not a broken map', async (t) => {
  const { db, get, stop } = await start();
  t.after(stop);
  db.close();
  const res = await get('?format=svg');
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'database_unavailable');
});
