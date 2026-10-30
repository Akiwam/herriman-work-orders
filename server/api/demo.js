// STORY-011 demo: a simulated Madison AI engine indexing and searching work orders over the API.
// Uses a throwaway in-memory database and a local port. Writes no files.
// Run with: npm run demo:api

import { openDatabase } from '../db.js';
import { createWorkOrder, updateWorkOrder } from '../workOrders.js';
import { createApiClient } from './clients.js';
import { createApiServer } from './server.js';
import { validateResponse } from './workOrderFeed.js';

const db = openDatabase(':memory:');
const line = () => console.log('-'.repeat(72));
const step = (n, text) => { line(); console.log(`STEP ${n} — ${text}`); line(); };

const samples = [
  ['Pothole on Example Way', 'pothole', 'Example Way near the stand-in school'],
  ['Broken streetlight', 'streetlight', 'Stand-in park, north entrance'],
  ['Graffiti on fence', 'graffiti', 'Behind the stand-in rec centre'],
  ['Hydrant leaking', 'hydrant', 'Sample Ave and 2nd'],
  ['Blocked storm drain', 'storm_drain', 'Demo Blvd, east side'],
];
for (const [title, type, place] of samples) {
  await createWorkOrder(db, { title, work_type: type, location_text: place, created_by: 'dispatcher.demo' });
}

const { key } = createApiClient(db, { name: 'Madison AI', actor: 'admin.demo' });
const server = createApiServer(db);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
const call = async (path, k = key) => {
  const res = await fetch(`${base}${path}`, { headers: k ? { Authorization: `Bearer ${k}` } : {}, signal: AbortSignal.timeout(5000) });
  return { status: res.status, body: await res.json() };
};

console.log('\nHerriman City Work Orders — STORY-011 demo (simulated Madison AI)');
console.log(`API running at ${base}  (local only, throwaway data)\n`);

step(1, 'An administrator registers Madison AI and gets its key (shown once)');
console.log(`  key: ${key.slice(0, 13)}…  (masked here; stored only as a hash)`);

step(2, 'Madison AI reads the contract: GET /openapi.json');
const contract = await call('/openapi.json', null);
console.log(`  ${contract.status}  OpenAPI ${contract.body.openapi}, ${Object.keys(contract.body.paths).length} endpoints, `
  + `WorkOrder has ${contract.body.components.schemas.WorkOrder.required.length} fields`);

step(3, 'Madison AI indexes everything, 2 per page (AC1, AC2)');
let cursor = null;
let pageNo = 0;
do {
  pageNo += 1;
  const { status, body } = await call(`/work-orders?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
  const problems = validateResponse(body);
  console.log(`  page ${pageNo}: ${status}  ${body.items.map((i) => `"${i.title}"`).join(', ')}`
    + `   format: ${problems.length ? `WRONG (${problems.join('; ')})` : 'correct'}`);
  cursor = body.next_cursor;
} while (cursor);

step(4, 'Madison AI searches: GET /work-orders/search?q=stand-in');
const found = await call('/work-orders/search?q=stand-in');
console.log(`  ${found.status}  ${found.body.items.length} matches: ${found.body.items.map((i) => `"${i.title}"`).join(', ')}`);

step(5, 'A work order changes; Madison AI re-indexes only what changed');
const since = new Date().toISOString();
const [first] = (await call('/work-orders?limit=1')).body.items;
await new Promise((r) => setTimeout(r, 5));
await updateWorkOrder(db, first.id, { priority: 'high' }, { actor: 'supervisor.demo' });
const changed = await call(`/work-orders/changes?since=${encodeURIComponent(since)}`);
console.log(`  ${changed.status}  ${changed.body.items.length} changed: ${changed.body.items.map((i) => `"${i.title}" (priority ${i.priority})`).join(', ')}`);

step(6, 'Someone tries with a wrong key');
const denied = await call('/work-orders', 'hwo_deadbeef_thisisnotavalidkey');
console.log(`  ${denied.status}  ${denied.body.error}: ${denied.body.message}  — no data returned`);

step(7, 'Audit trail of every API access (AC3)');
const rows = db.prepare("SELECT action, actor, after_json, occurred_at FROM audit_entries WHERE entity_type = 'api_access' ORDER BY id").all();
for (const r of rows) {
  const d = JSON.parse(r.after_json);
  console.log(`  ${r.occurred_at}  ${r.action.padEnd(6)} ${r.actor.padEnd(10)} ${d.operation.padEnd(17)}`
    + `${d.records_returned !== undefined ? ` ${d.records_returned} record${d.records_returned === 1 ? '' : 's'}` : ` (${d.reason})`}`);
}

await new Promise((resolve) => server.close(resolve));
line();
console.log('Demo finished. API stopped; nothing was written to disk.\n');
