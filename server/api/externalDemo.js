// STORY-004 demo: a simulated external system works with work orders over the API.
// Stand-in GIS, throwaway in-memory database, local port. Writes no files.
// Run with: npm run demo:external

import { openDatabase } from '../db.js';
import { updateWorkOrder } from '../workOrders.js';
import { createApiClient, READ_SCOPE, WORK_ORDERS_WRITE_SCOPE } from './clients.js';
import { createApiServer } from './server.js';
import { createGisClient, createGisLogger, createStandInGis, loadStandInAssets } from '../gis.js';

const db = openDatabase(':memory:');
const gis = createGisClient(createStandInGis(loadStandInAssets()), { log: createGisLogger(db), timeoutMs: 2000, attempts: 2, delayMs: 50 });
const external = createApiClient(db, { name: 'Asset system', scopes: [READ_SCOPE, WORK_ORDERS_WRITE_SCOPE], actor: 'admin.demo' });
const madison = createApiClient(db, { name: 'Madison AI', actor: 'admin.demo' });
const server = createApiServer(db, { gis });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
const call = async (method, path, { key = external.key, body, headers = {} } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  return { status: res.status, headers: res.headers, body: await res.json() };
};
const line = () => console.log('-'.repeat(72));
const step = (n, text) => { line(); console.log(`STEP ${n} — ${text}`); line(); };

console.log('\nHerriman City Work Orders — STORY-004 demo (a simulated external "Asset system")');
console.log('GIS: STAND-IN. Contract: GET /api/v1/openapi.json\n');

step(1, 'The Asset system creates a work order from a GIS asset (AC1, AC2)');
const order = { actor: 'asset-sync', title: 'Hydrant inspection failed', asset_ids: ['HY-0101'] };
const created = await call('POST', '/work-orders', { body: order, headers: { 'Idempotency-Key': 'asset-sync-7781' } });
const id = created.body.item.id;
console.log(`  ${created.status}  id ${id.slice(0, 8)}…  type=${created.body.item.work_type} (autofilled from GIS)  ETag ${created.headers.get('etag')}  gis_sync=${created.body.meta.gis_sync}`);
const retry = await call('POST', '/work-orders', { body: order, headers: { 'Idempotency-Key': 'asset-sync-7781' } });
console.log(`  Network retry with the same Idempotency-Key: ${retry.status}  replayed=${retry.headers.get('idempotent-replayed')}  same id=${retry.body.item.id === id}`);

step(2, 'It reads the work order and remembers the version');
const read = await call('GET', `/work-orders/${id}`);
const seen = read.headers.get('etag');
console.log(`  ${read.status}  status=${read.body.item.status}  priority=${read.body.item.priority}  ETag ${seen}`);

step(3, 'Meanwhile a dispatcher changes it inside the city system');
await updateWorkOrder(db, id, { priority: 'high', description: 'Crew to bring replacement valve' }, { actor: 'dispatcher.demo' });
console.log('  priority → high, description added (work order is now version 2)');

step(4, 'The Asset system updates from its stale copy — data mismatch is caught');
const stale = await call('PATCH', `/work-orders/${id}`, { body: { actor: 'asset-sync', priority: 'low' }, headers: { 'If-Match': seen } });
console.log(`  ${stale.status}  ${stale.body.error}: ${stale.body.message}`);
console.log(`  Current data returned: priority=${stale.body.current.item.priority}, ETag ${stale.headers.get('etag')} — nothing was overwritten`);

step(5, 'It re-reads, decides, and retries with the new version');
const fixed = await call('PATCH', `/work-orders/${id}`, { body: { actor: 'asset-sync', title: 'Hydrant inspection failed — valve' }, headers: { 'If-Match': stale.headers.get('etag') } });
console.log(`  ${fixed.status}  title="${fixed.body.item.title}"  priority=${fixed.body.item.priority} (dispatcher's change kept)  ETag ${fixed.headers.get('etag')}`);

step(6, 'It completes the work order');
const done = await call('POST', `/work-orders/${id}/complete`, { body: { actor: 'asset-sync', note: 'Valve replaced, retested OK' }, headers: { 'If-Match': fixed.headers.get('etag') } });
console.log(`  ${done.status}  status=${done.body.item.status}  completed_at=${done.body.item.completed_at}`);

step(7, 'Requests that break the contract, or use the wrong key');
const bad = await call('POST', '/work-orders', { body: { title: 7, colour: 'red' } });
console.log(`  ${bad.status}  ${bad.body.problems.join('; ')}`);
const noIfMatch = await call('PATCH', `/work-orders/${id}`, { body: { actor: 'asset-sync', priority: 'low' } });
console.log(`  ${noIfMatch.status}  ${noIfMatch.body.error}`);
const denied = await call('POST', '/work-orders', { key: madison.key, body: order });
console.log(`  ${denied.status}  ${denied.body.error}: ${denied.body.message}   (Madison AI's read-only key)`);

step(8, 'The request log — every API interaction, with timestamps and details (AC3)');
await new Promise((r) => setTimeout(r, 20));
for (const r of db.prepare('SELECT * FROM api_request_log ORDER BY id').all()) {
  const fields = r.body_fields ? JSON.parse(r.body_fields).join(',') : '';
  console.log(`  ${r.received_at}  ${r.method.padEnd(5)} ${r.path.replace('/api/v1', '').replace(id, '{id}').padEnd(24)} ${String(r.status).padEnd(4)}`
    + `${r.client_name.padEnd(13)} ${String(r.duration_ms).padStart(3)} ms  ${r.error_code ?? ''}${fields ? `  body: ${fields}` : ''}`);
}

step(9, 'Audit trail for the work order');
for (const a of db.prepare('SELECT action, actor, occurred_at FROM audit_entries WHERE entity_id = ? ORDER BY id').all(id)) {
  console.log(`  ${a.occurred_at}  ${a.action.padEnd(9)} by ${a.actor}`);
}

await new Promise((resolve) => server.close(resolve));
line();
console.log('Demo finished. API stopped; nothing was written to disk.\n');
