// STORY-006 demo: an administrator adds a workflow, changes it, and retires it, while a crew app
// moves work orders along. Throwaway in-memory database and local port; nothing is saved.
// Run with: npm run demo:workflows

import { openDatabase } from './db.js';
import { createApiClient, READ_SCOPE, WORK_ORDERS_WRITE_SCOPE, WORKFLOWS_ADMIN_SCOPE } from './api/clients.js';
import { createApiServer } from './api/server.js';

const db = openDatabase(':memory:');
const line = () => console.log('-'.repeat(72));
const step = (n, text) => { line(); console.log(`STEP ${n} — ${text}`); line(); };

const admin = createApiClient(db, { name: 'Workflow admin console', scopes: [READ_SCOPE, WORKFLOWS_ADMIN_SCOPE], actor: 'admin.demo' });
const crew = createApiClient(db, { name: 'Crew app', scopes: [READ_SCOPE, WORK_ORDERS_WRITE_SCOPE], actor: 'admin.demo' });
const server = createApiServer(db);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
const call = async (method, path, { key = admin.key, body, etag } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(etag ? { 'If-Match': etag } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, etag: res.headers.get('etag'), body: await res.json() };
};
const where = (r) => `${r.body.meta.workflow.workflow_name} v${r.body.meta.workflow.workflow_version}, at "${r.body.meta.workflow.current_step_name}"`
  + ` → next: ${r.body.meta.workflow.next_steps.map((s) => s.name).join(', ') || '—'}${r.body.meta.workflow.can_complete ? ' (or complete)' : ''}`;
const move = async (wo, to) => {
  const r = await call('POST', `/work-orders/${wo.body.item.id}/transition`, { key: crew.key, body: { actor: 'sam.crew', to }, etag: wo.etag });
  if (r.status !== 200) throw new Error(`move to ${to} failed: ${r.status} ${r.body.message}`);
  return r;
};
const newPothole = (title) => call('POST', '/work-orders', { key: crew.key, body: { actor: 'clerk.demo', title, work_type: 'pothole', location_text: 'Stand-in: 13400 S Rosecrest Rd' } });

const potholeV1 = {
  actor: 'jane.admin', key: 'pothole_repair', name: 'Pothole repair', work_type: 'pothole',
  steps: [
    { key: 'received', name: 'Received', next: ['scheduled'] },
    { key: 'scheduled', name: 'Scheduled', next: ['in_progress'] },
    { key: 'in_progress', name: 'In progress', next: ['completed', 'scheduled'] },
    { key: 'completed', name: 'Completed', next: [], final: true },
  ],
};

try {
  step(1, 'The existing workflow: with no workflow of its own, a pothole follows Standard (open → completed)');
  const before = await newPothole('Pothole before any workflow');
  console.log(where(before));

  step(2, 'An administrator publishes a pothole workflow');
  const v1 = await call('POST', '/workflows', { body: potholeV1 });
  console.log(`${v1.status}: ${v1.body.item.name} v${v1.body.item.version} — ${v1.body.item.steps.map((s) => s.name).join(' → ')}`);
  console.log(`The earlier work order is unaffected: ${where({ body: { meta: { workflow: (await call('GET', `/work-orders/${before.body.item.id}/workflow`, { key: crew.key })).body.item } } })}`);

  step(3, 'A new pothole follows it; the crew moves it along');
  let early = await newPothole('Pothole on Rosecrest');
  console.log(`created:  ${where(early)}`);
  early = await move(early, 'scheduled');
  console.log(`moved:    ${where(early)}`);
  const skip = await call('POST', `/work-orders/${early.body.item.id}/complete`, { key: crew.key, body: { actor: 'sam.crew', note: 'done' }, etag: early.etag });
  console.log(`complete too early → ${skip.status}: ${skip.body.message}`);

  step(4, 'A bad change is refused, with every problem listed, and nothing is saved');
  const bad = structuredClone(potholeV1);
  bad.steps[1].next = [];
  bad.steps.push({ key: 'traffic_plan', name: 'Traffic plan', next: ['nowhere'] });
  const refused = await call('POST', '/workflows', { body: bad });
  console.log(`${refused.status}: ${refused.body.message}`);
  for (const p of refused.body.problems) console.log(`  - ${p}`);

  step(5, 'A good change is published as version 2; work under way stays on version 1');
  const v2def = structuredClone(potholeV1);
  v2def.steps.splice(1, 0, { key: 'traffic_plan', name: 'Traffic plan approved', next: ['scheduled'] });
  v2def.steps[0].next = ['traffic_plan'];
  const v2 = await call('POST', '/workflows', { body: v2def });
  console.log(`${v2.status}: ${v2.body.item.name} v${v2.body.item.version} — ${v2.body.item.steps.map((s) => s.name).join(' → ')}`);
  const late = await newPothole('Pothole on Main St');
  console.log(`new work order:      ${where(late)}`);
  early = await move(early, 'in_progress');
  console.log(`work under way:      ${where(early)}`);
  const done = await call('POST', `/work-orders/${early.body.item.id}/complete`, { key: crew.key, body: { actor: 'sam.crew', note: 'Filled and compacted' }, etag: early.etag });
  console.log(`completed:           ${done.body.item.status}, at "${done.body.meta.workflow.current_step_name}"`);

  step(6, 'The workflow is retired: new potholes go back to Standard');
  const retired = await call('POST', '/workflows/pothole_repair/retire', { body: { actor: 'jane.admin' } });
  console.log(`${retired.status}: v${retired.body.item.version} is ${retired.body.item.status}`);
  console.log(`new work order:      ${where(await newPothole('Pothole after retiring'))}`);
  console.log(`still on v2:         ${(await call('GET', `/work-orders/${late.body.item.id}/workflow`, { key: crew.key })).body.item.workflow_version}`);

  step(7, 'Trust: every workflow change and every move, with user and time');
  const rows = db.prepare(`SELECT occurred_at, entity_type, action, actor FROM audit_entries
                           WHERE entity_type = 'workflow' OR action = 'transition' ORDER BY id`).all();
  for (const r of rows) console.log(`${r.occurred_at}  ${r.entity_type.padEnd(10)} ${r.action.padEnd(10)} ${r.actor}`);
  line();
} finally {
  server.close();
}
