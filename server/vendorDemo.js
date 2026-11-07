// STORY-009 demo: Madison AI, Lama and SpryPoint each read their own one-way feed (REQ-042, REQ-055),
// the city coordinates and tests each one (REQ-054), and every exchange is logged.
// Throwaway in-memory database and local port; nothing is saved. Keys are shortened when printed.
// Run with: npm run demo:vendors

import { openDatabase } from './db.js';
import { bootstrapAdministrator, issueUserKey, createUser, grantRole } from './access.js';
import { createApiClient } from './api/clients.js';
import { createApiServer } from './api/server.js';
import { createWorkOrder, updateWorkOrder } from './workOrders.js';
import { runVendorCheck, formatReport } from './vendorCheck.js';
import { AUTOMATIC_CHECKS } from './readiness.js';

const db = openDatabase(':memory:');
const line = () => console.log('-'.repeat(72));
const step = (n, text) => { line(); console.log(`STEP ${n} — ${text}`); line(); };

const admin = bootstrapAdministrator(db, { email: 'jane.admin@herriman.example', display_name: 'Jane Admin' });
const pat = createUser(db, { email: 'pat.pm@herriman.example', display_name: 'Pat Project-Manager' }, { actorUserId: admin.id });
grantRole(db, { userId: pat.id, roleId: 'project_manager' }, { actorUserId: admin.id });
const patKey = issueUserKey(db, pat.id, { actorUserId: admin.id }).key;
const keys = {
  madison_ai: createApiClient(db, { name: 'Madison AI', scopes: ['vendor_feed:madison_ai'], actor: 'jane.admin' }).key,
  lama: createApiClient(db, { name: 'Lama', scopes: ['vendor_feed:lama'], actor: 'jane.admin' }).key,
  sprypoint: createApiClient(db, { name: 'SpryPoint', scopes: ['vendor_feed:sprypoint'], actor: 'jane.admin' }).key,
};
const ids = [];
for (const [i, [title, type]] of [['Water main leak - resident Mrs Jones, 801-555-0101', 'water_leak'], ['Streetlight out on 13400 S', 'streetlight'],
  ['Pothole on Main St', 'pothole'], ['Hydrant damaged by a car', 'hydrant']].entries()) {
  ids.push((await createWorkOrder(db, { title, work_type: type, location_text: 'Stand-in location', created_by: 'clerk.demo' }, { now: () => `2026-11-0${i + 1}T09:00:00.000Z` })).id);
}

const server = createApiServer(db);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const call = async (method, path, key, body) => {
  const res = await fetch(`${baseUrl}/api/v1${path}`, {
    method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

try {
  step(1, 'The published contracts: one-way, each vendor gets its own fields');
  for (const v of (await call('GET', '/vendors')).body.items) {
    const c = v.contracts.at(-1);
    console.log(`${v.name.padEnd(11)} contract v${c.version} (${c.status.padEnd(8)}) ${c.fields.length} fields: ${c.fields.join(', ').slice(0, 80)}${c.fields.join(', ').length > 80 ? '…' : ''}`);
  }

  step(2, 'Each vendor reads its own feed');
  const lama = await call('GET', '/vendors/lama/feed', keys.lama);
  console.log(`Lama       → ${lama.status}: ${lama.body.items.length} work orders, e.g. ${JSON.stringify(lama.body.items[0])}`);
  console.log(`             (no title, notes or names: "Mrs Jones" is ${JSON.stringify(lama.body).includes('Jones') ? 'PRESENT — wrong' : 'not sent'})`);
  const madison = await call('GET', '/vendors/madison_ai/feed?limit=1', keys.madison_ai);
  console.log(`Madison AI → ${madison.status}: full format for indexing, e.g. title "${madison.body.items[0].title}"`);
  let spry = await call('GET', '/vendors/sprypoint/feed', keys.sprypoint);
  const saved = spry.body.next_cursor;
  console.log(`SpryPoint  → ${spry.status}: ${spry.body.items.length} work orders; saves its cursor`);
  await updateWorkOrder(db, ids[2], { priority: 'high' }, { actor: 'crew.demo', now: () => '2026-11-06T09:00:00.000Z' });
  spry = await call('GET', `/vendors/sprypoint/feed?cursor=${saved}`, keys.sprypoint);
  console.log(`             a crew raises the pothole to high priority; SpryPoint's next read → ${spry.body.items.length} change: ${spry.body.items.map((i) => `${i.work_type} now ${i.priority}`).join()}`);

  step(3, 'Unauthorized access and bad requests are refused');
  const cross = await call('GET', '/vendors/sprypoint/feed', keys.lama);
  console.log(`Lama's key on SpryPoint's feed → ${cross.status}  ${cross.body.message}`);
  const anon = await call('GET', '/vendors/lama/feed');
  console.log(`No key                          → ${anon.status}  ${anon.body.message}`);
  const write = await call('POST', '/vendors/lama/feed', keys.lama, { status: 'completed' });
  console.log(`Lama tries to send data         → ${write.status}  ${write.body.message}`);
  const version = await call('GET', '/vendors/lama/feed?contract=2', keys.lama);
  console.log(`Lama asks for contract v2       → ${version.status}  ${version.body.problems[0]}`);

  step(4, 'Data mismatch: data that breaks the contract is never sent');
  db.prepare("UPDATE work_orders SET created_at = 'damaged' WHERE id = ?").run(ids[3]);
  const mismatch = await call('GET', '/vendors/lama/feed', keys.lama);
  console.log(`Lama reads after a record is damaged → ${mismatch.status} ${mismatch.body.error}: ${mismatch.body.message}`);
  db.prepare("UPDATE work_orders SET created_at = '2026-11-04T09:00:00.000Z' WHERE id = ?").run(ids[3]);

  step(5, 'REQ-054 testing: the conformance kit run against this system');
  console.log(formatReport(await runVendorCheck({ baseUrl, vendor: 'lama', key: keys.lama, pageSize: 2 })));

  step(6, 'REQ-054 coordination: Pat records Lama\'s steps (in order, with notes)');
  const early = await call('PUT', '/vendors/lama/coordination/signed_off', patKey, { done: true, note: 'Looks fine' });
  console.log(`Sign off before testing → ${early.status}  ${early.body.problems[0]}`);
  for (const [s, note] of [['contract_shared', 'Contract v1 sent to Lama (example)'], ['fields_confirmed', 'Lama confirmed the fields (example)'],
    ['sandbox_tested', 'vendor:check passed, see step 5'], ['signed_off', 'Signed off by Public Works and Lama (example)']]) {
    await call('PUT', `/vendors/lama/coordination/${s}`, patKey, { done: true, note });
  }
  const coord = (await call('GET', '/vendors/lama/coordination', patKey)).body.item;
  for (const s of coord.steps) console.log(`  ${s.done ? 'DONE' : '    '}  ${s.step.padEnd(17)} ${s.note}  (${s.updated_at})`);
  console.log(`Lama signed off: ${coord.signed_off}`);

  step(7, 'The readiness assessment now sees real exchanges');
  const at = new Date().toISOString();
  for (const v of ['lama', 'sprypoint', 'madison_ai']) {
    const r = await AUTOMATIC_CHECKS[`testing.vendor_${v}`].run(db, at);
    console.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.detail}`);
  }

  step(8, 'Trust: every vendor interaction is logged with times and request details');
  for (const r of db.prepare('SELECT * FROM vendor_exchange_log ORDER BY id').all()) {
    console.log(`${r.started_at}  ${r.vendor.padEnd(10)} ${r.client_name.padEnd(10)} ${r.outcome.padEnd(8)} ${String(r.records_returned).padStart(2)} records  ${r.duration_ms} ms  ${r.params_json ?? ''}  (request ${String(r.request_id).slice(0, 8)}…)`);
  }
  line();
} finally {
  server.close();
}
