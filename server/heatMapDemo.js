// STORY-005 demo: a planner requests heat maps of made-up work orders.
// Throwaway in-memory database and local port. The SVG images are saved to your system's temporary
// folder (never inside the repo) so you can open them in a browser.
// Run with: npm run demo:heatmap

import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from './db.js';
import { createWorkOrder } from './workOrders.js';
import { createApiClient, HEATMAPS_SCOPE } from './api/clients.js';
import { createApiServer } from './api/server.js';

const db = openDatabase(':memory:');
const line = () => console.log('-'.repeat(72));
const step = (n, text) => { line(); console.log(`STEP ${n} — ${text}`); line(); };

// Three made-up clusters of work orders, plus some with only a freeform location.
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const clusters = [
  { lat: 40.5125, lng: -112.0330, n: 40, type: 'pothole' },
  { lat: 40.5050, lng: -112.0200, n: 18, type: 'streetlight' },
  { lat: 40.5200, lng: -112.0450, n: 9, type: 'graffiti' },
];
for (const c of clusters) {
  for (let i = 0; i < c.n; i += 1) {
    const wo = await createWorkOrder(db, { title: `${c.type} report`, work_type: c.type, location_text: 'Stand-in site', created_by: 'demo' });
    db.prepare('UPDATE work_orders SET latitude = ?, longitude = ? WHERE id = ?')
      .run(c.lat + (rand() - 0.5) * 0.006, c.lng + (rand() - 0.5) * 0.008, wo.id);
  }
}
for (let i = 0; i < 6; i += 1) await createWorkOrder(db, { title: 'graffiti report', work_type: 'graffiti', location_text: 'Behind the stand-in rec centre', created_by: 'demo' });

const planner = createApiClient(db, { name: 'Planning dept', scopes: [HEATMAPS_SCOPE], actor: 'admin.demo' });
const madison = createApiClient(db, { name: 'Madison AI', actor: 'admin.demo' });
const server = createApiServer(db);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1/heat-maps`;
const get = async (query, key = planner.key) => {
  const res = await fetch(`${base}${query}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) });
  const isJson = (res.headers.get('content-type') ?? '').includes('json');
  return { status: res.status, body: isJson ? await res.json() : await res.text() };
};
const outDir = mkdtempSync(join(tmpdir(), 'herriman-heatmaps-'));
const save = (name, svg) => { const p = join(outDir, name); writeFileSync(p, svg); return p; };

console.log('\nHerriman City Work Orders — STORY-005 demo (heat maps)');
console.log('Work orders are made up: 67 in three clusters, 6 with only a freeform location.\n');

step(1, 'All work orders, 250 m cells — GeoJSON summary (AC1)');
const all = await get('?format=geojson');
const counts = all.body.features.map((f) => f.properties.count).sort((a, b) => b - a);
console.log(`  ${all.status}  ${all.body.features.length} cells, busiest ${counts[0]}, then ${counts.slice(1, 5).join(', ')}, …`);
console.log(`  mapped ${all.body.properties.mapped} of ${all.body.properties.total_matching}; ${all.body.properties.unmapped} have no coordinates`);
const sum = all.body.features.reduce((s, f) => s + f.properties.count, 0);
console.log(`  check: ${sum} in cells + ${all.body.properties.unmapped} unmapped = ${sum + all.body.properties.unmapped} (matches ${all.body.properties.total_matching})  (AC2)`);

step(2, 'The same as an image');
const svgAll = await get('?format=svg');
console.log(`  ${svgAll.status}  saved: ${save('all-types-250m.svg', svgAll.body)}`);

step(3, 'Potholes only, and everything with 1 km cells');
const potholes = await get('?format=svg&work_types=pothole');
console.log(`  potholes:  ${potholes.status}  saved: ${save('potholes-250m.svg', potholes.body)}`);
const coarse = await get('?format=svg&cell_size_m=1000');
console.log(`  1 km:      ${coarse.status}  saved: ${save('all-types-1km.svg', coarse.body)}`);

step(4, 'Asking for too much detail (map generation error)');
db.prepare("UPDATE work_orders SET latitude = 40.80, longitude = -111.70 WHERE id = (SELECT id FROM work_orders WHERE work_type = 'streetlight' LIMIT 1)").run();
const tooFine = await get('?format=svg&cell_size_m=50');
console.log(`  ${tooFine.status}  ${tooFine.body.error}: ${tooFine.body.message}`);

step(5, 'Someone without heat map access (unauthorized)');
const denied = await get('?format=svg', madison.key);
console.log(`  ${denied.status}  ${denied.body.error}: ${denied.body.message}`);

step(6, 'Every heat map generation, with parameters and timestamps (AC3)');
for (const r of db.prepare('SELECT * FROM heat_map_log ORDER BY id').all()) {
  const p = JSON.parse(r.params_json);
  const filters = `${p.work_types ? p.work_types.join(',') : 'all types'}, ${p.cell_size_m} m`;
  console.log(`  ${r.started_at}  ${r.requested_by.padEnd(13)} ${r.format.padEnd(7)} ${r.outcome.padEnd(6)} ${filters.padEnd(20)} `
    + `${r.cell_count ?? '-'} cells, ${r.mapped ?? '-'} mapped, ${r.duration_ms} ms${r.error ? `  — ${r.error.slice(0, 60)}…` : ''}`);
}

await new Promise((resolve) => server.close(resolve));
line();
console.log(`Demo finished. Open the SVG files above in a browser to see the heat maps.\nFolder: ${outDir}\n`);
