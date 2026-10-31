// STORY-004 over real HTTP: a simulated external system creates, reads, updates and completes work orders.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../server/db.js';
import { getWorkOrder, updateWorkOrder } from '../server/workOrders.js';
import { createApiClient, WORK_ORDERS_WRITE_SCOPE, READ_SCOPE } from '../server/api/clients.js';
import { createApiServer } from '../server/api/server.js';
import { validateResponse } from '../server/api/workOrderFeed.js';
import { createGisClient, createGisLogger, createStandInGis, loadStandInAssets } from '../server/gis.js';

async function start() {
  const db = openDatabase();
  const backend = createStandInGis(loadStandInAssets());
  const gis = createGisClient(backend, { log: createGisLogger(db), timeoutMs: 500, attempts: 2, delayMs: 1 });
  const external = createApiClient(db, { name: 'External system', scopes: [READ_SCOPE, WORK_ORDERS_WRITE_SCOPE], actor: 'admin-1' });
  const madison = createApiClient(db, { name: 'Madison AI', actor: 'admin-1' });
  const server = createApiServer(db, { gis });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (method, path, { key = external.key, body, headers = {} } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
      signal: AbortSignal.timeout(5000),
    });
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  return { db, backend, external, madison, call, stop: () => new Promise((resolve) => server.close(resolve)) };
}

const newOrder = (extra = {}) => ({ actor: 'integration-bot', title: 'Hydrant leaking', work_type: 'hydrant', location_text: 'Stand-in site 4', ...extra });

// ---------- AC1 + AC2: requests are processed to the spec, and updates reflect in the system ----------

test('AC1 + AC2: create, read, update and complete over the API — each reflected in the system, audited and in the published format', async (t) => {
  const { db, call, stop } = await start();
  t.after(stop);

  const created = await call('POST', '/work-orders', { body: newOrder() });
  assert.equal(created.status, 201);
  assert.deepEqual(validateResponse(created.body), []);
  assert.equal(created.headers.get('etag'), '"v1"');
  const id = created.body.item.id;
  assert.equal(created.headers.get('location'), `/api/v1/work-orders/${id}`);
  assert.equal(getWorkOrder(db, id).created_by, 'integration-bot via External system');

  const read = await call('GET', `/work-orders/${id}`);
  assert.equal(read.headers.get('etag'), '"v1"');

  const updated = await call('PATCH', `/work-orders/${id}`, { body: { actor: 'integration-bot', priority: 'high' }, headers: { 'If-Match': read.headers.get('etag') } });
  assert.equal(updated.status, 200);
  assert.deepEqual(validateResponse(updated.body), []);
  assert.equal(updated.body.item.priority, 'high');
  assert.equal(updated.headers.get('etag'), '"v2"');
  assert.equal(getWorkOrder(db, id).priority, 'high', 'the update is reflected in the system');

  const done = await call('POST', `/work-orders/${id}/complete`, { body: { actor: 'integration-bot', note: 'Valve replaced' }, headers: { 'If-Match': '"v2"' } });
  assert.equal(done.status, 200);
  assert.equal(done.body.item.status, 'completed');
  assert.equal(getWorkOrder(db, id).completion_note, 'Valve replaced');

  const actions = db.prepare('SELECT action, actor FROM audit_entries WHERE entity_id = ? ORDER BY id').all(id).map((r) => `${r.action} by ${r.actor}`);
  assert.deepEqual(actions, ['create by integration-bot via External system', 'update by integration-bot via External system', 'complete by integration-bot via External system']);
});

test('a work order created from a GIS asset over the API is autofilled and pushed to GIS (reuses STORY-002)', async (t) => {
  const { backend, call, stop } = await start();
  t.after(stop);
  const created = await call('POST', '/work-orders', { body: { actor: 'integration-bot', title: 'Light out', asset_ids: ['SL-0001'] } });
  assert.equal(created.status, 201);
  assert.equal(created.body.item.work_type, 'streetlight');
  assert.equal(created.body.meta.gis_sync, 'synced');
  assert.equal((await backend.getAsset('SL-0001')).linked_work_orders[0].work_order_id, created.body.item.id);
});

test('the same create sent twice with one Idempotency-Key makes one work order', async (t) => {
  const { db, call, stop } = await start();
  t.after(stop);
  const headers = { 'Idempotency-Key': 'ext-create-0001' };
  const first = await call('POST', '/work-orders', { body: newOrder(), headers });
  const again = await call('POST', '/work-orders', { body: newOrder(), headers });
  assert.equal(first.status, 201);
  assert.equal(again.status, 200);
  assert.equal(again.headers.get('idempotent-replayed'), 'true');
  assert.equal(again.body.item.id, first.body.item.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_orders').get().n, 1);
});

// ---------- failure path: data mismatch ----------

test('data mismatch: an update from a stale copy gets 412 with the current work order, and changes nothing', async (t) => {
  const { db, call, stop } = await start();
  t.after(stop);
  const { body } = await call('POST', '/work-orders', { body: newOrder() });
  const id = body.item.id;
  await updateWorkOrder(db, id, { title: 'Hydrant leaking badly' }, { actor: 'dispatcher' }); // someone else → v2

  const stale = await call('PATCH', `/work-orders/${id}`, { body: { actor: 'integration-bot', title: 'Hydrant fixed' }, headers: { 'If-Match': '"v1"' } });
  assert.equal(stale.status, 412);
  assert.equal(stale.body.error, 'precondition_failed');
  assert.equal(stale.headers.get('etag'), '"v2"');
  assert.equal(stale.body.current.item.title, 'Hydrant leaking badly', 'the caller gets the current data to re-read');
  assert.equal(getWorkOrder(db, id).title, 'Hydrant leaking badly', 'nothing was overwritten');

  const retry = await call('PATCH', `/work-orders/${id}`, { body: { actor: 'integration-bot', title: 'Hydrant fixed' }, headers: { 'If-Match': stale.headers.get('etag') } });
  assert.equal(retry.status, 200);
});

test('a change without If-Match gets 428; a malformed If-Match gets 400', async (t) => {
  const { db, call, stop } = await start();
  t.after(stop);
  const { body } = await call('POST', '/work-orders', { body: newOrder() });
  const missing = await call('PATCH', `/work-orders/${body.item.id}`, { body: { actor: 'x', priority: 'high' } });
  assert.equal(missing.status, 428);
  assert.equal(missing.body.error, 'precondition_required');
  assert.equal((await call('PATCH', `/work-orders/${body.item.id}`, { body: { actor: 'x', priority: 'high' }, headers: { 'If-Match': '3' } })).status, 400);
  assert.equal(getWorkOrder(db, body.item.id).priority, 'normal');
});

// ---------- failure path: API request fails (does not follow the specification) ----------

test('requests that break the contract get 400 listing every problem, and nothing is created', async (t) => {
  const { db, call, stop } = await start();
  t.after(stop);
  const bad = await call('POST', '/work-orders', { body: { title: 42, colour: 'red', asset_ids: 'SL-0001' } });
  assert.equal(bad.status, 400);
  for (const p of ['colour is not a field this endpoint accepts', 'actor is required', 'title must be text', 'asset_ids must be a list of text values']) {
    assert.ok(bad.body.problems.includes(p), `missing problem: ${p}`);
  }
  assert.equal((await call('POST', '/work-orders', { body: '{nope' })).status, 400);
  const businessRule = await call('POST', '/work-orders', { body: { actor: 'x', title: 'No location' } });
  assert.equal(businessRule.status, 400, 'the work order rules still apply (a location is required)');
  assert.equal((await call('PATCH', '/work-orders/no-such-id', { body: { actor: 'x', priority: 'high' }, headers: { 'If-Match': '"v1"' } })).status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_orders').get().n, 0);
});

test('completing a completed work order, or completing without a note, is refused', async (t) => {
  const { call, stop } = await start();
  t.after(stop);
  const { body } = await call('POST', '/work-orders', { body: newOrder() });
  const id = body.item.id;
  assert.equal((await call('POST', `/work-orders/${id}/complete`, { body: { actor: 'x' }, headers: { 'If-Match': '"v1"' } })).status, 400);
  assert.equal((await call('POST', `/work-orders/${id}/complete`, { body: { actor: 'x', note: 'Done' }, headers: { 'If-Match': '"v1"' } })).status, 200);
  assert.equal((await call('POST', `/work-orders/${id}/complete`, { body: { actor: 'x', note: 'Again' }, headers: { 'If-Match': '"v2"' } })).status, 409);
});

// ---------- failure path: unauthorized access ----------

test('no key gets 401 and a read-only key gets 403 on every write, each audited, and nothing changes', async (t) => {
  const { db, madison, call, stop } = await start();
  t.after(stop);
  const { body } = await call('POST', '/work-orders', { body: newOrder() });
  const id = body.item.id;
  for (const [key, expected] of [[null, 401], [madison.key, 403]]) {
    assert.equal((await call('POST', '/work-orders', { key, body: newOrder() })).status, expected);
    assert.equal((await call('PATCH', `/work-orders/${id}`, { key, body: { actor: 'x', priority: 'high' }, headers: { 'If-Match': '"v1"' } })).status, expected);
    assert.equal((await call('POST', `/work-orders/${id}/complete`, { key, body: { actor: 'x', note: 'n' }, headers: { 'If-Match': '"v1"' } })).status, expected);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_orders').get().n, 1);
  assert.equal(getWorkOrder(db, id).priority, 'normal');
  const denied = db.prepare("SELECT actor FROM audit_entries WHERE entity_type = 'api_access' AND action = 'denied'").all().map((r) => r.actor);
  assert.deepEqual(denied, ['anonymous', 'anonymous', 'anonymous', 'Madison AI', 'Madison AI', 'Madison AI']);
});

// ---------- the published specification matches what the endpoints accept ----------

test('the OpenAPI contract documents the writes with exactly the fields the endpoints accept', async (t) => {
  const { call, stop } = await start();
  t.after(stop);
  const doc = (await call('GET', '/openapi.json', { key: null })).body;
  const { BODIES } = await import('../server/api/workOrderWrites.js');
  const documented = {
    create: doc.paths['/work-orders'].post,
    update: doc.paths['/work-orders/{id}'].patch,
    complete: doc.paths['/work-orders/{id}/complete'].post,
  };
  for (const [action, op] of Object.entries(documented)) {
    const schema = op.requestBody.content['application/json'].schema;
    assert.deepEqual(Object.keys(schema.properties).sort(), Object.keys(BODIES[action]).sort(), `${action}: documented fields`);
    const required = Object.entries(BODIES[action]).filter(([, type]) => !type.endsWith('?')).map(([f]) => f).sort();
    assert.deepEqual([...schema.required].sort(), required, `${action}: required fields`);
    assert.equal(schema.additionalProperties, false, `${action}: unknown fields are documented as refused`);
  }
  assert.ok(documented.update.parameters.some((p) => p.name === 'If-Match' && p.required));
  assert.ok(documented.create.parameters.some((p) => p.name === 'Idempotency-Key'));
  for (const code of ['412', '428', '403']) assert.ok(documented.update.responses[code], `update documents ${code}`);
});

// ---------- AC3: every interaction is in the request log ----------

test('AC3: every write, accepted or refused, is in the request log with its details', async (t) => {
  const { db, madison, call, stop } = await start();
  t.after(stop);
  const { body } = await call('POST', '/work-orders', { body: newOrder() });
  await call('PATCH', `/work-orders/${body.item.id}`, { body: { actor: 'x', priority: 'high' }, headers: { 'If-Match': '"v9"' } });
  await call('POST', '/work-orders', { key: madison.key, body: newOrder() });
  await new Promise((r) => setTimeout(r, 20));
  const rows = db.prepare('SELECT method, path, client_name, status, error_code, body_fields FROM api_request_log ORDER BY id').all();
  assert.deepEqual(rows.map((r) => [r.method, r.client_name, r.status, r.error_code]), [
    ['POST', 'External system', 201, null],
    ['PATCH', 'External system', 412, 'precondition_failed'],
    ['POST', 'Madison AI', 403, 'forbidden'],
  ]);
  assert.deepEqual(JSON.parse(rows[0].body_fields), ['actor', 'title', 'work_type', 'location_text']);
});
