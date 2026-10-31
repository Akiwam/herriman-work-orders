// STORY-006 over real HTTP: an administrator publishes and retires workflows; an outside system
// moves work orders along them.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../server/db.js';
import { getWorkOrder } from '../server/workOrders.js';
import { createApiClient, READ_SCOPE, WORK_ORDERS_WRITE_SCOPE, WORKFLOWS_ADMIN_SCOPE } from '../server/api/clients.js';
import { createApiServer } from '../server/api/server.js';
import { validateResponse } from '../server/api/workOrderFeed.js';
import { publishWorkOrder, getPublicView } from '../server/publicRequests.js';
import { WORKFLOW_FIELDS, STEP_FIELDS } from '../server/api/workflowRoutes.js';

async function start() {
  const db = openDatabase();
  const admin = createApiClient(db, { name: 'Workflow admin console', scopes: [READ_SCOPE, WORKFLOWS_ADMIN_SCOPE], actor: 'admin-1' });
  const crew = createApiClient(db, { name: 'Crew app', scopes: [READ_SCOPE, WORK_ORDERS_WRITE_SCOPE], actor: 'admin-1' });
  const server = createApiServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (method, path, { key = admin.key, body, headers = {} } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  return { db, admin, crew, call, stop: () => new Promise((resolve) => server.close(resolve)) };
}

const pothole = (extra = {}) => ({
  actor: 'jane.admin',
  key: 'pothole_repair',
  name: 'Pothole repair',
  work_type: 'pothole',
  steps: [
    { key: 'received', name: 'Received', next: ['scheduled'] },
    { key: 'scheduled', name: 'Scheduled', next: ['in_progress'] },
    { key: 'in_progress', name: 'In progress', next: ['completed', 'scheduled'] },
    { key: 'completed', name: 'Completed', next: [], final: true },
  ],
  ...extra,
});
const newOrder = { actor: 'crew-bot', title: 'Pothole on 13400 S', work_type: 'pothole', location_text: '13400 S Rosecrest Rd' };

test('an administrator publishes a workflow, then a new version; both are listed and audited with the user', async (t) => {
  const { db, call, stop } = await start();
  t.after(stop);

  const first = await call('POST', '/workflows', { body: pothole() });
  assert.equal(first.status, 201);
  assert.equal(first.body.item.version, 1);
  assert.equal(first.headers.get('location'), '/api/v1/workflows/pothole_repair');

  const again = await call('POST', '/workflows', { body: pothole() });
  assert.equal(again.status, 200, 'the same definition again changes nothing');
  assert.equal(again.body.unchanged, true);

  const changed = pothole();
  changed.steps[0].next = ['scheduled', 'completed'];
  const second = await call('POST', '/workflows', { body: changed });
  assert.equal(second.status, 201);
  assert.equal(second.body.item.version, 2);

  const list = await call('GET', '/workflows');
  const entry = list.body.items.find((w) => w.key === 'pothole_repair');
  assert.equal(entry.active_version, 2);
  assert.deepEqual(entry.versions.map((v) => [v.version, v.status]), [[2, 'active'], [1, 'superseded']]);
  assert.ok(list.body.items.some((w) => w.key === 'standard'));

  const one = await call('GET', '/workflows/pothole_repair');
  assert.equal(one.body.item.version, 2);
  assert.deepEqual(one.body.item.steps[0].next, ['scheduled', 'completed']);

  const audits = db.prepare("SELECT actor, action FROM audit_entries WHERE entity_type = 'workflow' ORDER BY id").all().map((r) => ({ ...r }));
  assert.deepEqual(audits, [
    { actor: 'jane.admin via Workflow admin console', action: 'publish' },
    { actor: 'jane.admin via Workflow admin console', action: 'publish' },
  ]);
});

test('a workflow that could strand work orders gets 422 listing every problem, and nothing is saved', async (t) => {
  const { db, call, stop } = await start();
  t.after(stop);
  const bad = pothole();
  bad.steps[1].next = [];                     // dead end
  bad.steps.push({ key: 'orphan', name: 'Orphan', next: ['completed'] }); // unreachable — reported once the dead end is fixed
  const res = await call('POST', '/workflows', { body: bad });
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'invalid_workflow');
  assert.ok(res.body.problems.some((p) => /scheduled: is a dead end/.test(p)));

  const unknown = await call('POST', '/workflows', { body: { ...pothole(), colour: 'red', steps: pothole().steps.map((s, i) => (i ? s : { ...s, owner: 'x' })) } });
  assert.equal(unknown.status, 422);
  assert.ok(unknown.body.problems.includes('colour is not a field this endpoint accepts'));
  assert.ok(unknown.body.problems.includes('steps[0].owner is not a field a step accepts'));

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM workflows WHERE workflow_key != 'standard'").get().n, 0);
});

test('a second workflow for the same work type gets 409', async (t) => {
  const { call, stop } = await start();
  t.after(stop);
  await call('POST', '/workflows', { body: pothole() });
  const res = await call('POST', '/workflows', { body: pothole({ key: 'pothole_express' }) });
  assert.equal(res.status, 409);
});

test('a work order is moved along its workflow over the API, with If-Match, and completed from an allowed step', async (t) => {
  const { db, crew, call, stop } = await start();
  t.after(stop);
  await call('POST', '/workflows', { body: pothole() });

  const created = await call('POST', '/work-orders', { key: crew.key, body: newOrder });
  assert.equal(created.status, 201);
  assert.equal(created.body.meta.workflow.current_step, 'received');
  assert.deepEqual(created.body.meta.workflow.next_steps, [{ key: 'scheduled', name: 'Scheduled', role: null }]);
  assert.deepEqual(validateResponse({ schema_version: created.body.schema_version, item: created.body.item }), [], 'the published work order format is unchanged');
  const id = created.body.item.id;

  const noMatch = await call('POST', `/work-orders/${id}/transition`, { key: crew.key, body: { actor: 'sam', to: 'scheduled' } });
  assert.equal(noMatch.status, 428);

  const moved = await call('POST', `/work-orders/${id}/transition`, { key: crew.key, body: { actor: 'sam', to: 'scheduled' }, headers: { 'If-Match': created.headers.get('etag') } });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.meta.workflow.current_step, 'scheduled');
  assert.equal(moved.headers.get('etag'), '"v2"');

  const stale = await call('POST', `/work-orders/${id}/transition`, { key: crew.key, body: { actor: 'sam', to: 'in_progress' }, headers: { 'If-Match': created.headers.get('etag') } });
  assert.equal(stale.status, 412);

  const skip = await call('POST', `/work-orders/${id}/transition`, { key: crew.key, body: { actor: 'sam', to: 'completed' }, headers: { 'If-Match': '"v2"' } });
  assert.equal(skip.status, 409, 'the final step needs completion with a note');
  const tooEarly = await call('POST', `/work-orders/${id}/complete`, { key: crew.key, body: { actor: 'sam', note: 'Filled' }, headers: { 'If-Match': '"v2"' } });
  assert.equal(tooEarly.status, 409);

  const working = await call('POST', `/work-orders/${id}/transition`, { key: crew.key, body: { actor: 'sam', to: 'in_progress' }, headers: { 'If-Match': '"v2"' } });
  assert.equal(working.body.meta.workflow.can_complete, true);
  const done = await call('POST', `/work-orders/${id}/complete`, { key: crew.key, body: { actor: 'sam', note: 'Filled and compacted' }, headers: { 'If-Match': '"v3"' } });
  assert.equal(done.status, 200);
  assert.equal(done.body.item.status, 'completed');
  assert.equal(done.body.meta.workflow.current_step, 'completed');

  const position = await call('GET', `/work-orders/${id}/workflow`, { key: crew.key });
  assert.equal(position.body.item.current_step_name, 'Completed');

  const moves = db.prepare("SELECT actor, before_json, after_json FROM audit_entries WHERE entity_id = ? AND action = 'transition' ORDER BY id").all(id);
  assert.equal(moves.length, 2);
  assert.equal(moves[0].actor, 'sam via Crew app');
  assert.equal(JSON.parse(moves[0].before_json).current_step, 'received');
  assert.equal(JSON.parse(moves[0].after_json).current_step, 'scheduled');
});

test('retiring a workflow sends new work orders back to Standard; work already on it keeps it', async (t) => {
  const { db, crew, call, stop } = await start();
  t.after(stop);
  await call('POST', '/workflows', { body: pothole() });
  const before = await call('POST', '/work-orders', { key: crew.key, body: newOrder });

  const retired = await call('POST', '/workflows/pothole_repair/retire', { body: { actor: 'jane.admin' } });
  assert.equal(retired.status, 200);
  assert.equal(retired.body.item.status, 'retired');
  assert.equal((await call('GET', '/workflows/pothole_repair')).status, 404);
  assert.equal((await call('POST', '/workflows/standard/retire', { body: { actor: 'jane.admin' } })).status, 409);

  const after = await call('POST', '/work-orders', { key: crew.key, body: { ...newOrder, title: 'Another pothole' } });
  assert.equal(after.body.meta.workflow.workflow_key, 'standard');
  assert.equal(getWorkOrder(db, before.body.item.id).current_step, 'received');
  const stillMoves = await call('POST', `/work-orders/${before.body.item.id}/transition`, { key: crew.key, body: { actor: 'sam', to: 'scheduled' }, headers: { 'If-Match': '"v1"' } });
  assert.equal(stillMoves.status, 200);

  const audit = db.prepare("SELECT actor FROM audit_entries WHERE entity_type = 'workflow' AND action = 'retire'").get();
  assert.equal(audit.actor, 'jane.admin via Workflow admin console');
});

test('without the right scope, workflow changes and moves are refused (401/403), audited, and change nothing', async (t) => {
  const { db, crew, admin, call, stop } = await start();
  t.after(stop);
  assert.equal((await call('POST', '/workflows', { key: null, body: pothole() })).status, 401);
  assert.equal((await call('POST', '/workflows', { key: crew.key, body: pothole() })).status, 403);
  await call('POST', '/workflows', { body: pothole() });
  assert.equal((await call('POST', '/workflows/pothole_repair/retire', { key: crew.key, body: { actor: 'sam' } })).status, 403);

  const wo = await call('POST', '/work-orders', { key: crew.key, body: newOrder });
  const res = await call('POST', `/work-orders/${wo.body.item.id}/transition`, { key: admin.key, body: { actor: 'jane', to: 'scheduled' }, headers: { 'If-Match': '"v1"' } });
  assert.equal(res.status, 403, 'administering workflows does not allow moving work orders');
  assert.equal(getWorkOrder(db, wo.body.item.id).current_step, 'received');

  const denied = db.prepare("SELECT after_json FROM audit_entries WHERE entity_type = 'api_access' AND action = 'denied'").all().map((r) => JSON.parse(r.after_json).operation);
  assert.deepEqual(denied, ['publishWorkflow', 'publishWorkflow', 'retireWorkflow', 'transitionWorkOrder']);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM workflows WHERE workflow_key = 'pothole_repair'").get().n, 1);
});

test('the public sees a step change only as "Progress update" — never the step name or who moved it', async (t) => {
  const { db, crew, call, stop } = await start();
  t.after(stop);
  await call('POST', '/workflows', { body: pothole({ steps: [
    { key: 'received', name: 'Received', next: ['legal_hold'] },
    { key: 'legal_hold', name: 'Waiting on claim against resident', next: ['completed'] },
    { key: 'completed', name: 'Completed', next: [], final: true },
  ] }) });
  const wo = await call('POST', '/work-orders', { key: crew.key, body: newOrder });
  await call('POST', `/work-orders/${wo.body.item.id}/transition`, { key: crew.key, body: { actor: 'sam', to: 'legal_hold' }, headers: { 'If-Match': '"v1"' } });
  publishWorkOrder(db, wo.body.item.id, { actor: 'clerk-1' });

  const view = getPublicView(db, { workOrderId: wo.body.item.id });
  assert.deepEqual(view.history.map((h) => h.event), ['Request received', 'Progress update']);
  assert.doesNotMatch(JSON.stringify(view), /claim against|legal_hold|sam/);
});

test('every workflow request is in the request log with field names only, and the contract matches the checks', async (t) => {
  const { db, call, stop } = await start();
  t.after(stop);
  await call('POST', '/workflows', { body: pothole() });
  const row = db.prepare("SELECT * FROM api_request_log WHERE path = '/api/v1/workflows' AND method = 'POST'").get();
  assert.equal(row.status, 201);
  assert.equal(row.client_name, 'Workflow admin console');
  assert.deepEqual(JSON.parse(row.body_fields).sort(), [...WORKFLOW_FIELDS].sort());
  assert.doesNotMatch(JSON.stringify(row), /Pothole repair|jane\.admin/);

  const doc = (await call('GET', '/openapi.json', { key: null })).body;
  const body = doc.paths['/workflows'].post.requestBody.content['application/json'].schema;
  assert.deepEqual(Object.keys(body.properties), WORKFLOW_FIELDS);
  assert.deepEqual(Object.keys(doc.components.schemas.WorkflowStep.properties), STEP_FIELDS);
  assert.deepEqual(Object.keys(doc.paths['/work-orders/{id}/transition'].post.requestBody.content['application/json'].schema.properties), ['actor', 'to']);
  assert.ok(doc.paths['/work-orders/{id}/transition'].post.parameters.some((p) => p.name === 'If-Match' && p.required));
});
