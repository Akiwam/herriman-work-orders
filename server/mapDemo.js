// STORY-016 demo: work orders on a map and as a heat map, read from the same records the API uses.
// Throwaway in-memory database; nothing is saved. The console's Map tab draws exactly this data
// (npm run console, then Map).
// Run with: npm run demo:map

import { openDatabase } from './db.js';
import { createWorkOrder } from './workOrders.js';
import { createGisClient, createGisLogger, createStandInGis, loadStandInAssets } from './gis.js';
import { analyzeWorkOrders } from './heatMaps.js';
import { mapPoints, withGisCheck } from './mapView.js';

const db = openDatabase(':memory:');
const line = () => console.log('-'.repeat(72));
const step = (n, text) => { line(); console.log(`STEP ${n} — ${text}`); line(); };
const healthy = createStandInGis(loadStandInAssets());
let gisDown = false;
const backend = { ...healthy, getAsset: (id, auth) => (gisDown ? new Promise(() => {}) : healthy.getAsset(id, auth)) }; // "down" never answers
const gis = createGisClient(backend, { log: createGisLogger(db), timeoutMs: 300, attempts: 2, delayMs: 10 });

// October and November work: some from GIS assets (coordinates from GIS), some typed in by hand.
const assets = ['SL-0001', 'SL-0002', 'HY-0101']; // stand-in GIS assets
for (let i = 0; i < 12; i += 1) {
  const month = i < 5 ? '10' : '11';
  const at = `2026-${month}-${String(3 + i).padStart(2, '0')}T09:00:00.000Z`;
  const input = i % 4 === 3
    ? { title: `Graffiti report ${i + 1}`, work_type: 'graffiti', location_text: 'Behind the stand-in rec centre', created_by: 'clerk.demo' }
    : { title: `Asset work ${i + 1}`, created_by: 'clerk.demo', asset_ids: [assets[i % assets.length]] };
  await createWorkOrder(db, input, { gis, now: () => at });
}

step(1, 'Each work order with a location is plotted at its GIS coordinates');
const all = await withGisCheck(mapPoints(db), gis);
for (const p of all.points.slice(0, 5)) console.log(`  ${p.title.padEnd(16)} ${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}  (${p.position_from}; GIS: ${p.gis_check})`);
console.log(`  … ${all.points.length} plotted. Not on the map: ${all.unplaced.length}, e.g. "${all.unplaced[0].title}": ${all.unplaced[0].reason}`);

step(2, 'A date range: the heat map reflects only work orders in that range');
for (const range of [{}, { from: '2026-11-01' }, { from: '2026-10-01', to: '2026-11-01' }]) {
  const heat = analyzeWorkOrders(db, range);
  const map = mapPoints(db, range);
  const label = range.from ? `created ${range.from}${range.to ? ` to before ${range.to}` : ' onwards'}` : 'all dates';
  console.log(`  ${label.padEnd(36)} heat map: ${heat.mapped} in ${heat.cells.length} cell(s), ${heat.unmapped} unmapped · map: ${map.points.length} plotted, ${map.unplaced.length} listed`);
}
const empty = mapPoints(db, { from: '2025-01-01', to: '2025-02-01' });
console.log(`  2025-01-01 to 2025-02-01: empty=${empty.empty}, so the screen says "No work orders created from 2025-01-01 and before 2025-02-01"`);

step(3, 'GIS moves an asset before the sync runs: flagged, not silently moved');
healthy.editAsset('SL-0002', { location: { lat: 40.5200, lng: -112.0400 } });
const flagged = (await withGisCheck(mapPoints(db), gis)).points.filter((p) => p.gis_check === 'differs');
for (const p of flagged) console.log(`  ${p.title}: shown at stored ${p.lat.toFixed(4)}, ${p.lng.toFixed(4)} · GIS now ${p.gis_location.lat.toFixed(4)}, ${p.gis_location.lng.toFixed(4)}`);

step(4, 'GIS times out: the map says so and still lists every work order');
gisDown = true;
const started = Date.now();
const down = await withGisCheck(mapPoints(db), gis);
console.log(`  gis_status=${down.gis_status} after ${Date.now() - started} ms · ${down.points.length} plotted + ${down.unplaced.length} listed = ${down.points.length + down.unplaced.length} of ${all.total}, nothing dropped`);

step(5, 'Trust: the map and the heat map count the same work orders, from the same stored records');
const heat = analyzeWorkOrders(db);
console.log(`  heat map: ${heat.total_matching} matching, ${heat.mapped} placed, ${heat.unmapped} not placed`);
console.log(`  map:      ${all.total} matching, ${all.points.length} placed, ${all.unplaced.length} not placed`);
line();
