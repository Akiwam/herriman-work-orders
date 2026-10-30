// STORY-003 demo: a citizen reports a problem and follows it; staff publish and complete it.
// Throwaway in-memory database, local port. Writes no files.
// Run with: npm run demo:public

import { openDatabase } from '../db.js';
import { getWorkOrder, completeWorkOrder } from '../workOrders.js';
import { createApiServer } from '../api/server.js';
import { publishWorkOrder } from '../publicRequests.js';

const db = openDatabase(':memory:');
const server = createApiServer(db);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1/public`;
const call = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  return { status: res.status, body: await res.json() };
};
const line = () => console.log('-'.repeat(72));
const step = (n, text) => { line(); console.log(`STEP ${n} — ${text}`); line(); };

console.log('\nHerriman City Work Orders — STORY-003 demo (public site)');
console.log(`Public page: http://127.0.0.1:${server.address().port}/public  (throwaway data)\n`);

step(1, 'A citizen reports a problem: POST /public/requests');
const report = {
  description: 'Water bubbling up through the sidewalk outside the library',
  location_text: 'Stand-in address: 55 Sample Ave',
  category: 'water_leak',
  contact: 'resident@example.com',
  submission_id: 'demo-report-0001',
};
const sent = await call('POST', '/requests', report);
console.log(`  ${sent.status}  tracking code ${sent.body.tracking_code}  status=${sent.body.status}`);
const again = await call('POST', '/requests', report);
console.log(`  Double-click sends it again: ${again.status}  duplicate=${again.body.duplicate}, same code=${again.body.tracking_code === sent.body.tracking_code}`);

step(2, 'It appears in the work order system (AC1)');
const req = db.prepare('SELECT * FROM service_requests WHERE tracking_code = ?').get(sent.body.tracking_code);
const wo = getWorkOrder(db, req.work_order_id);
console.log(`  work order ${wo.id.slice(0, 8)}…  "${wo.title}"  type=${wo.work_type}  status=${wo.status}  by ${wo.created_by}  public=${wo.is_public === 1}`);

step(3, 'The citizen checks their request by tracking code');
const tracked = await call('GET', `/requests/${sent.body.tracking_code}`);
console.log(`  ${tracked.status}  status=${tracked.body.item.status}  history: ${tracked.body.item.history.map((h) => h.event).join(' → ')}`);

step(4, 'Before staff publish it, nobody else can see it (unauthorized access)');
const hidden = await call('GET', `/work-orders/${wo.id}`);
console.log(`  ${hidden.status}  ${hidden.body.message}`);

step(5, 'Staff publish it and the crew completes it; the public view shows status and history (AC2)');
publishWorkOrder(db, wo.id, { actor: 'supervisor.demo' });
await completeWorkOrder(db, wo.id, { note: 'Internal: replaced service valve, crew 3', actor: 'crew.demo' });
const view = await call('GET', `/work-orders/${wo.id}`);
console.log(`  ${view.status}  status=${view.body.item.status}`);
for (const h of view.body.item.history) console.log(`    ${h.at}  ${h.event}`);
const leaked = ['supervisor.demo', 'crew.demo', 'Internal:', 'resident@example.com'].filter((s) => JSON.stringify(view.body).includes(s));
console.log(`  Staff names, internal notes or contact details shown: ${leaked.length ? leaked.join(', ') : 'none'}`);

step(6, 'A form with problems, and then too many reports from one address');
const bad = await call('POST', '/requests', { description: 'leak' });
console.log(`  ${bad.status}  ${bad.body.problems.join('; ')}`);
let last;
for (let i = 2; i <= 6; i += 1) last = await call('POST', '/requests', { ...report, submission_id: `demo-report-000${i}` });
console.log(`  6th report this hour: ${last.status}  ${last.body.message}`);

step(7, 'Every public submission, with time and IP address (AC3)');
for (const r of db.prepare('SELECT * FROM public_submission_log ORDER BY id').all()) {
  console.log(`  ${r.submitted_at}  ${String(r.ip_address).padEnd(10)} ${r.outcome.padEnd(13)}${r.detail ? `  ${r.detail}` : ''}`);
}

await new Promise((resolve) => server.close(resolve));
line();
console.log('Demo finished. Server stopped; nothing was written to disk.\n');
