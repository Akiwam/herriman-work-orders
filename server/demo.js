// STORY-001 demo: create → update → GIS outage and retry → complete → audit trail.
// Runs against the STAND-IN GIS and a throwaway in-memory database. Writes no files.
// Run with: npm run demo

import { openDatabase } from './db.js';
import { createWorkOrder, updateWorkOrder, completeWorkOrder, syncPending } from './workOrders.js';
import { createStandInGis, createGisClient, createGisLogger, loadStandInAssets } from './gis.js';
import { processGisChanges } from './gisInbound.js';
import { getWorkOrder } from './workOrders.js';

const db = openDatabase(':memory:');
const backend = createStandInGis(loadStandInAssets());

// A switch to simulate the GIS going down, so the demo can show the failure path.
let gisDown = false;
const switchable = {
  kind: backend.kind,
  getAsset: (id) => backend.getAsset(id),
  getChangesSince: (cursor) => backend.getChangesSince(cursor),
  linkWorkOrder: (assetId, link) => (gisDown
    ? Promise.reject(new Error('GIS unavailable (simulated outage)'))
    : backend.linkWorkOrder(assetId, link)),
};
const gis = createGisClient(switchable, { log: createGisLogger(db), timeoutMs: 2000, attempts: 2, delayMs: 50 });

const line = () => console.log('-'.repeat(72));
const step = (n, text) => { line(); console.log(`STEP ${n} — ${text}`); line(); };
const show = (label, value) => console.log(`  ${label.padEnd(18)} ${value ?? '—'}`);
async function showGisLink(assetId) {
  const asset = await backend.getAsset(assetId);
  const link = asset.linked_work_orders[0];
  console.log(`  GIS asset ${assetId} now shows:`);
  if (!link) { console.log('    (no work order linked)'); return; }
  show('  title', link.title);
  show('  priority', link.priority);
  show('  status', link.status);
  show('  updated_at', link.updated_at);
}

console.log('\nHerriman City Work Orders — STORY-001 demo');
console.log(`GIS in use: ${backend.kind.toUpperCase()} (made-up assets, not the city's real GIS)\n`);

step(1, 'Create a work order by selecting a GIS asset (AC1)');
const created = await createWorkOrder(db, {
  request_id: 'demo-create-1',
  title: 'Streetlight out',
  asset_ids: ['SL-0001'],
  created_by: 'dispatcher.demo',
}, { gis });
show('id', created.id);
show('title', created.title);
show('work_type', `${created.work_type}   ← autofilled from GIS`);
show('address', `${created.address}   ← autofilled from GIS`);
show('coordinates', `${created.latitude}, ${created.longitude}   ← autofilled from GIS`);
show('asset', `${created.assets[0].asset_id} (${created.assets[0].asset_name})`);
show('GIS sync', created.gis_sync);
await showGisLink('SL-0001');

const again = await createWorkOrder(db, {
  request_id: 'demo-create-1', title: 'Streetlight out', asset_ids: ['SL-0001'], created_by: 'dispatcher.demo',
}, { gis });
console.log(`\n  Same request sent again (double-click): duplicate=${again.duplicate}, same id=${again.id === created.id}`);

step(2, 'Update it — the change is saved and reflected in GIS (AC2)');
const updated = await updateWorkOrder(db, created.id, { priority: 'high', title: 'Streetlight out — pole leaning' },
  { actor: 'supervisor.demo', gis });
show('title', updated.title);
show('priority', updated.priority);
show('GIS sync', updated.gis_sync);
await showGisLink('SL-0001');

step(3, 'Failure path — GIS is down during an update');
gisDown = true;
const duringOutage = await updateWorkOrder(db, created.id, { description: 'Crew to bring a bucket truck' },
  { actor: 'supervisor.demo', gis });
show('saved locally', duringOutage.description);
show('GIS sync', `${duringOutage.gis_sync}   ← not lost, waiting to retry`);
show('GIS error', duringOutage.gis_failures[0]?.error);
gisDown = false;
const retryFailures = await syncPending(db, gis, created.id);
console.log(`\n  GIS back up — retry: ${retryFailures.length === 0 ? 'succeeded' : 'failed again'}`);
await showGisLink('SL-0001');

step(4, 'Complete it — a completion note is required (REQ-051)');
const done = await completeWorkOrder(db, created.id, { note: 'Pole straightened, LED head replaced', actor: 'crew.demo', gis });
show('status', done.status);
show('completed_at', done.completed_at);
show('completion_note', done.completion_note);
await showGisLink('SL-0001');

step(5, 'Freeform location when GIS has no asset for the place (REQ-032)');
const freeform = await createWorkOrder(db, {
  title: 'Graffiti on fence', work_type: 'graffiti', location_text: 'Behind the stand-in rec centre, north wall', created_by: 'dispatcher.demo',
}, { gis });
show('location_text', freeform.location_text);
show('GIS sync', `${freeform.gis_sync}   ← no asset, nothing to sync`);

step(6, 'STORY-002 — an edit made in GIS flows into the work order (AC2)');
const hydrant = await createWorkOrder(db, { title: 'Hydrant leaking', asset_ids: ['HY-0101'], created_by: 'dispatcher.demo' }, { gis });
show('before: address', hydrant.address);
show('before: coords', `${hydrant.latitude}, ${hydrant.longitude}`);
console.log('\n  Someone corrects the hydrant in GIS, and also edits the streetlight from STEP 1 …');
backend.editAsset('HY-0101', { address: 'Stand-in address: 224 Sample Ave', location: { lat: 40.5123, lng: -112.0361 } });
backend.editAsset('SL-0001', { address: 'Stand-in address: 101 Example Way' });
const inbound = await processGisChanges(db, gis);
const hydrantNow = getWorkOrder(db, hydrant.id);
show('after: address', `${hydrantNow.address}   ← from GIS`);
show('after: coords', `${hydrantNow.latitude}, ${hydrantNow.longitude}   ← from GIS`);
show('title unchanged', hydrantNow.title);
for (const o of inbound.outcomes) {
  console.log(`  ${o.asset_id}: work order ${o.work_order_id.slice(0, 8)}… ${o.result}${o.reason ? ` (${o.reason})` : ''}`);
}
const rerun = await processGisChanges(db, gis);
console.log(`  Run it again: ${rerun.outcomes.length} changes applied (nothing twice)`);

step(7, 'STORY-002 — unauthorized access is refused, not retried');
const secured = createStandInGis(loadStandInAssets(), { requireToken: `demo-${crypto.randomUUID()}` });
const wrongKey = createGisClient(secured, { log: createGisLogger(db), token: 'not-the-right-credential', attempts: 3, delayMs: 10 });
try {
  await wrongKey.getAsset('SL-0001');
} catch (err) {
  show('result', `${err.code}: ${err.message}`);
}
const unauthorizedRows = db.prepare("SELECT COUNT(*) AS n FROM gis_log WHERE outcome = 'unauthorized'").get().n;
show('attempts logged', `${unauthorizedRows}   ← one try only; the credential itself is never logged`);

step(8, 'Audit trail — every action, who did it, and when (AC3)');
const rows = db.prepare('SELECT entity_id, action, actor, occurred_at FROM audit_entries ORDER BY id').all();
for (const r of rows) {
  console.log(`  ${r.occurred_at}  ${r.action.padEnd(9)} by ${r.actor.padEnd(16)} work order ${r.entity_id.slice(0, 8)}…`);
}
const syncLog = db.prepare('SELECT asset_id, status, attempts, last_error FROM gis_sync ORDER BY id').all();
console.log('\n  GIS sync log:');
for (const s of syncLog) console.log(`  ${s.asset_id}  ${s.status.padEnd(7)} attempts=${s.attempts}${s.last_error ? `  last error: ${s.last_error}` : ''}`);

step(9, 'STORY-002 — every GIS interaction, logged with timestamps (AC3)');
const gisRows = db.prepare('SELECT * FROM gis_log ORDER BY id').all();
for (const g of gisRows) {
  console.log(`  ${g.started_at}  ${g.operation.padEnd(15)} ${String(g.asset_id ?? '—').padEnd(8)} try ${g.attempt}  ${g.outcome.padEnd(12)} ${g.duration_ms} ms${g.error ? `  ${g.error}` : ''}`);
}
line();
console.log('Demo finished. Nothing was written to disk.\n');
