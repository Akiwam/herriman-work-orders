// STORY-005 — heat maps of work orders.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../server/db.js';
import { createWorkOrder, completeWorkOrder, ValidationError } from '../server/workOrders.js';
import { submitPublicRequest } from '../server/publicRequests.js';
import {
  analyzeWorkOrders, cellDegrees, normaliseParams, CELL_SIZE, generateHeatMap, shadeIndex, HEAT_COLOURS, MapGenerationError, MAX_CELLS,
} from '../server/heatMaps.js';

const heatLog = (db) => db.prepare('SELECT * FROM heat_map_log ORDER BY id').all();

let minute = 0;
const at = () => new Date(Date.UTC(2026, 9, 1, 8, minute++)).toISOString();

/** A work order at a given point (test setup writes the coordinates directly). */
async function workOrderAt(db, lat, lng, workType = 'pothole', when = at) {
  const wo = await createWorkOrder(db, { title: `${workType} job`, work_type: workType, location_text: 'Stand-in site', created_by: 'user-1' }, { now: when });
  if (lat !== null) db.prepare('UPDATE work_orders SET latitude = ?, longitude = ? WHERE id = ?').run(lat, lng, wo.id);
  return wo;
}

/** Points well inside one 250 m cell, and one in a cell far away. */
const HOTSPOT = [[40.51231, -112.03311], [40.51235, -112.03312], [40.51229, -112.03309], [40.51233, -112.03315]];
const ELSEWHERE = [40.52001, -112.04502];

// ---------- AC1 + AC2: the analysis produces a heat map that matches the data ----------

test('AC1 + AC2: work orders are counted into grid cells exactly where they are', async () => {
  const db = openDatabase();
  for (const [lat, lng] of HOTSPOT) await workOrderAt(db, lat, lng);
  await workOrderAt(db, ...ELSEWHERE, 'streetlight');

  const map = analyzeWorkOrders(db);
  assert.equal(map.total_matching, 5);
  assert.equal(map.mapped, 5);
  assert.equal(map.cells.length, 2);
  assert.equal(map.cells[0].count, 4, 'the busiest cell comes first');
  assert.equal(map.max_count, 4);
  assert.deepEqual(map.cells[0].by_type, { pothole: 4 });
  assert.deepEqual(map.cells[1].by_type, { streetlight: 1 });

  // Every point really lies inside the cell it was counted in.
  const [lat, lng] = HOTSPOT[0];
  const { south, west, north, east } = map.cells[0].bounds;
  assert.ok(lat >= south && lat < north && lng >= west && lng < east);
});

test('the numbers always add up: cell counts + unmapped = matching work orders', async () => {
  const db = openDatabase();
  for (const [lat, lng] of HOTSPOT) await workOrderAt(db, lat, lng);
  await workOrderAt(db, null, null, 'graffiti');
  await workOrderAt(db, null, null, 'graffiti');

  const map = analyzeWorkOrders(db);
  assert.equal(map.total_matching, 6);
  assert.equal(map.unmapped, 2, 'freeform-only work orders are counted, not hidden');
  assert.equal(map.cells.reduce((sum, c) => sum + c.count, 0) + map.unmapped, map.total_matching);
});

test('a citizen\'s map pin is used when the work order itself has no coordinates', async () => {
  const db = openDatabase();
  await submitPublicRequest(db, {
    description: 'Pothole in the right-hand lane', location_text: 'Stand-in Example Way', category: 'pothole',
    latitude: HOTSPOT[0][0], longitude: HOTSPOT[0][1], submission_id: 'heat-pin-0001',
  }, { ip: '203.0.113.7' });
  const map = analyzeWorkOrders(db);
  assert.equal(map.mapped, 1);
  assert.equal(map.unmapped, 0);
});

test('filters by work type, date range and status', async () => {
  const db = openDatabase();
  const early = () => '2026-09-15T10:00:00.000Z';
  const late = () => '2026-10-15T10:00:00.000Z';
  await workOrderAt(db, ...HOTSPOT[0], 'pothole', early);
  const done = await workOrderAt(db, ...HOTSPOT[1], 'pothole', late);
  await workOrderAt(db, ...ELSEWHERE, 'streetlight', late);
  await completeWorkOrder(db, done.id, { note: 'Patched', actor: 'crew' });

  assert.equal(analyzeWorkOrders(db, { work_types: ['streetlight'] }).total_matching, 1);
  assert.equal(analyzeWorkOrders(db, { work_types: ['pothole', 'streetlight'] }).total_matching, 3);
  assert.equal(analyzeWorkOrders(db, { from: '2026-10-01' }).total_matching, 2);
  assert.equal(analyzeWorkOrders(db, { to: '2026-10-01' }).total_matching, 1);
  assert.equal(analyzeWorkOrders(db, { status: 'completed' }).total_matching, 1);
  assert.equal(analyzeWorkOrders(db, { status: 'open', work_types: ['pothole'] }).total_matching, 1);
});

test('a larger cell size merges nearby points; cells line up the same way on every run', async () => {
  const db = openDatabase();
  // Two points ~200 m apart around the centre of one 2 km cell (near a cell edge they could fall
  // either side of the boundary — that is how a fixed grid works).
  const big = cellDegrees(2000);
  const centreLat = (Math.floor(40.512 / big.lat) + 0.5) * big.lat;
  const centreLng = (Math.floor(-112.033 / big.lng) + 0.5) * big.lng;
  const step = 100 / 111_320; // 100 m in degrees of latitude
  await workOrderAt(db, centreLat - step, centreLng);
  await workOrderAt(db, centreLat + step, centreLng);
  assert.equal(analyzeWorkOrders(db, { cell_size_m: 50 }).cells.length, 2, '200 m apart is two 50 m cells');
  assert.equal(analyzeWorkOrders(db, { cell_size_m: 2000 }).cells.length, 1, 'and one 2 km cell');
  assert.deepEqual(analyzeWorkOrders(db, { cell_size_m: 50 }).cells.map((c) => c.cell_id), analyzeWorkOrders(db, { cell_size_m: 50 }).cells.map((c) => c.cell_id));
  const d = cellDegrees(250);
  assert.ok(Math.abs(d.lat * 111_320 - 250) < 1e-6, 'a 250 m cell is 250 m tall');
});

test('no matching work orders gives an empty heat map, not an error', () => {
  const db = openDatabase();
  const map = analyzeWorkOrders(db, { work_types: ['nothing'] });
  assert.deepEqual([map.total_matching, map.mapped, map.unmapped, map.cells.length, map.area], [0, 0, 0, 0, null]);
});

test('the result holds only counts — never work order ids, titles or people', async () => {
  const db = openDatabase();
  const wo = await workOrderAt(db, ...HOTSPOT[0]);
  const text = JSON.stringify(analyzeWorkOrders(db));
  for (const hidden of [wo.id, 'pothole job', 'user-1']) assert.ok(!text.includes(hidden), `leaked: ${hidden}`);
});

// ---------- failure path: data analysis fails (bad parameters) ----------

test('bad parameters are refused with every problem listed', () => {
  const db = openDatabase();
  assert.throws(() => analyzeWorkOrders(db, {
    cell_size_m: 10, work_types: 'pothole', status: 'maybe', from: 'last week', to: '2026-10-01', colour: 'red',
  }), (err) => {
    assert.ok(err instanceof ValidationError);
    for (const p of [`cell_size_m must be a whole number from ${CELL_SIZE.min} to ${CELL_SIZE.max}`, 'work_types must be a list of work type names',
      'status must be one of: all, open, completed', 'from must be an ISO date or date-time', 'colour is not a heat map parameter']) {
      assert.ok(err.problems.includes(p), `missing problem: ${p}`);
    }
    return true;
  });
  assert.throws(() => normaliseParams({ from: '2026-10-02', to: '2026-10-01' }), /from must be before to/);
  assert.throws(() => normaliseParams('cell_size_m=250'), /parameters must be an object/);
});

// ---------- drawing (AC1, AC2) ----------

async function sampleCity(db) {
  for (const [lat, lng] of HOTSPOT) await workOrderAt(db, lat, lng);           // 4 in one cell
  await workOrderAt(db, ...ELSEWHERE, 'streetlight');                            // 1 far away
  await workOrderAt(db, null, null, 'graffiti');                                 // 1 with no coordinates
}

test('AC1: GeoJSON — one square per cell with its count, ready for the city GIS', async () => {
  const db = openDatabase();
  await sampleCity(db);
  const { content, summary } = generateHeatMap(db, {}, { requestedBy: 'planner-1', format: 'geojson' });
  assert.equal(content.type, 'FeatureCollection');
  assert.equal(content.features.length, 2);
  const hot = content.features[0];
  assert.equal(hot.geometry.type, 'Polygon');
  assert.equal(hot.geometry.coordinates[0].length, 5, 'a closed square');
  assert.equal(hot.properties.count, 4);
  assert.equal(hot.properties.share, 1);
  assert.deepEqual([content.properties.mapped, content.properties.unmapped], [5, 1]);
  assert.equal(summary.cell_count, 2);
});

test('AC2: the SVG colours each cell by its count, and says how much of the data it shows', async () => {
  const db = openDatabase();
  await sampleCity(db);
  const { content: svg } = generateHeatMap(db, {}, { requestedBy: 'planner-1', format: 'svg' });
  assert.match(svg, /^<svg /);
  const cells = [...svg.matchAll(/data-count="(\d+)" data-shade="(\d)"[^>]*fill="(#[0-9a-f]{6})"/g)].map((m) => [Number(m[1]), Number(m[2]), m[3]]);
  assert.deepEqual(cells.map((c) => c[0]).sort((a, b) => b - a), [4, 1], 'one rectangle per cell, with the true counts');
  for (const [count, shade, fill] of cells) {
    assert.equal(shade, shadeIndex(count, 4), 'shade follows the count');
    assert.equal(fill, HEAT_COLOURS[shade]);
  }
  assert.equal(cells.find((c) => c[0] === 4)[2], HEAT_COLOURS.at(-1), 'the busiest cell is darkest');
  assert.match(svg, /5 of 6 work orders mapped; 1 have no coordinates/);
});

test('work type names are escaped in the SVG', async () => {
  const db = openDatabase();
  await workOrderAt(db, ...HOTSPOT[0], 'pothole<script>');
  const { content: svg } = generateHeatMap(db, { work_types: ['pothole<script>'] }, { requestedBy: 'planner-1', format: 'svg' });
  assert.ok(!svg.includes('<script>'));
  assert.match(svg, /pothole&lt;script&gt;/);
});

test('an empty heat map is drawn with a clear message, not an error', () => {
  const db = openDatabase();
  const { content: svg } = generateHeatMap(db, { work_types: ['nothing'] }, { requestedBy: 'planner-1', format: 'svg' });
  assert.match(svg, /No work orders with coordinates match these filters/);
});

// ---------- AC3: every generation is logged with parameters and timestamps ----------

test('AC3: a successful generation is logged with who, parameters, times and result counts', async () => {
  const db = openDatabase();
  await sampleCity(db);
  generateHeatMap(db, { work_types: ['pothole'], cell_size_m: 500 }, { requestedBy: 'planner-1', format: 'svg' });
  const [row] = heatLog(db);
  assert.equal(row.requested_by, 'planner-1');
  assert.equal(row.format, 'svg');
  assert.equal(row.outcome, 'ok');
  assert.deepEqual(JSON.parse(row.params_json), { cell_size_m: 500, work_types: ['pothole'], from: null, to: null, status: 'all' });
  assert.ok(Date.parse(row.started_at) <= Date.parse(row.finished_at));
  assert.ok(row.duration_ms >= 0);
  assert.deepEqual([row.total_matching, row.mapped, row.unmapped, row.cell_count], [4, 4, 0, 1]);
});

test('AC3: invalid requests are logged too, with the parameters as received and the problems', () => {
  const db = openDatabase();
  assert.throws(() => generateHeatMap(db, { cell_size_m: 1 }, { requestedBy: 'planner-1' }), ValidationError);
  assert.throws(() => generateHeatMap(db, {}, { requestedBy: 'planner-1', format: 'png' }), /format must be one of/);
  const rows = heatLog(db);
  assert.deepEqual(rows.map((r) => r.outcome), ['invalid', 'invalid']);
  assert.deepEqual(JSON.parse(rows[0].params_json), { cell_size_m: 1 });
  assert.match(rows[0].error, /cell_size_m must be/);
  assert.equal(rows[1].format, 'png');
});

// ---------- failure path: map generation error ----------

test('a map too detailed to draw is refused with advice, logged as failed, and nothing is returned', async () => {
  const db = openDatabase();
  // Points in two far-apart places, drawn with tiny cells: the grid between them would be enormous.
  await workOrderAt(db, 40.40, -112.20);
  await workOrderAt(db, 40.70, -111.80);
  assert.throws(() => generateHeatMap(db, { cell_size_m: 50 }, { requestedBy: 'planner-1', format: 'svg' }),
    (err) => err instanceof MapGenerationError && /too small for an area this wide/.test(err.message) && /larger cells/.test(err.message));
  const [row] = heatLog(db);
  assert.equal(row.outcome, 'failed');
  assert.match(row.error, /too small/);
  assert.equal(row.cell_count, 2);
  assert.ok(MAX_CELLS >= 1000, 'the cell limit is also in place');
});

test('if drawing fails, it is reported and logged as failed — never half a map', async () => {
  const db = openDatabase();
  await sampleCity(db);
  const broken = () => { throw new Error('renderer crashed'); };
  assert.throws(() => generateHeatMap(db, {}, { requestedBy: 'planner-1', format: 'svg', render: broken }),
    (err) => err instanceof MapGenerationError && err.message === 'The heat map could not be drawn.');
  const [row] = heatLog(db);
  assert.equal(row.outcome, 'failed');
});

test('if the analysis itself fails, it is reported as a generation error and logged', async () => {
  const db = openDatabase();
  db.exec('DROP TABLE service_requests'); // part of the data cannot be read
  assert.throws(() => generateHeatMap(db, {}, { requestedBy: 'planner-1' }), (err) => err instanceof MapGenerationError && /could not be analysed/.test(err.message));
  assert.equal(heatLog(db)[0].outcome, 'failed');
});

test('if the generation cannot be logged, the map is not returned', async () => {
  const db = openDatabase();
  await sampleCity(db);
  db.exec('DROP TABLE heat_map_log');
  assert.throws(() => generateHeatMap(db, {}, { requestedBy: 'planner-1' }));
});

test('a generation needs to know who is asking', () => {
  assert.throws(() => generateHeatMap(openDatabase(), {}, {}), /needs requestedBy/);
});
