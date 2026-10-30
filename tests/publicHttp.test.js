// STORY-003 over real HTTP: the public endpoints, as a citizen's browser would use them.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../server/db.js';
import { getWorkOrder, completeWorkOrder } from '../server/workOrders.js';
import { createApiServer } from '../server/api/server.js';
import { publishWorkOrder } from '../server/publicRequests.js';

async function start(options = {}) {
  const db = openDatabase();
  const server = createApiServer(db, options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/public`;
  const call = async (method, path, { body, headers = {} } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
      signal: AbortSignal.timeout(5000),
    });
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  const stop = () => new Promise((resolve) => server.close(resolve));
  return { db, call, stop };
}

let n = 0;
const request = (extra = {}) => ({
  description: 'Pothole about a foot wide in the right-hand lane',
  location_text: 'Stand-in address: Example Way near 300 block',
  category: 'pothole',
  submission_id: `browser-sub-${(n += 1).toString().padStart(4, '0')}`,
  ...extra,
});
const submissions = (db) => db.prepare('SELECT ip_address, outcome FROM public_submission_log ORDER BY id').all().map((r) => ({ ...r }));

test('AC1 + AC3 over HTTP: a citizen submits, the work order system has it, and the IP and time are logged', async (t) => {
  const { db, call, stop } = await start();
  t.after(stop);
  const res = await call('POST', '/requests', { body: request() });
  assert.equal(res.status, 201);
  assert.match(res.body.tracking_code, /^HWO-/);

  const req = db.prepare('SELECT * FROM service_requests WHERE tracking_code = ?').get(res.body.tracking_code);
  assert.equal(getWorkOrder(db, req.work_order_id).work_type, 'pothole', 'it appears in the work order system');
  const [entry] = submissions(db);
  assert.equal(entry.outcome, 'accepted');
  assert.equal(entry.ip_address, '127.0.0.1', 'the IP comes from the connection');
});

test('AC2 over HTTP: the citizen follows their request, and a published work order shows status and history', async (t) => {
  const { db, call, stop } = await start();
  t.after(stop);
  const { body: receipt } = await call('POST', '/requests', { body: request() });

  const tracked = await call('GET', `/requests/${receipt.tracking_code}`);
  assert.equal(tracked.status, 200);
  assert.equal(tracked.body.item.status, 'Open');

  const woId = db.prepare('SELECT work_order_id FROM service_requests WHERE tracking_code = ?').get(receipt.tracking_code).work_order_id;
  assert.equal((await call('GET', `/work-orders/${woId}`)).status, 404, 'not visible to everyone until published');

  publishWorkOrder(db, woId, { actor: 'supervisor.jones' });
  await completeWorkOrder(db, woId, { note: 'Patched', actor: 'crew.smith' });
  const view = await call('GET', `/work-orders/${woId}`);
  assert.equal(view.status, 200);
  assert.equal(view.body.item.status, 'Completed');
  assert.deepEqual(view.body.item.history.map((h) => h.event), ['Request received', 'Work completed']);

  const list = await call('GET', '/work-orders');
  assert.deepEqual(list.body.items.map((i) => i.id), [woId]);
});

// ---------- failure paths ----------

test('submission fails: invalid data gets 400 with the problems, and the attempt is still logged', async (t) => {
  const { db, call, stop } = await start();
  t.after(stop);
  const bad = await call('POST', '/requests', { body: { description: 'hi' } });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.problems.includes('location_text is required'));
  assert.equal((await call('POST', '/requests', { body: '{oops' })).status, 400);
  assert.equal((await call('POST', '/requests', { body: '["not", "an", "object"]' })).status, 400);
  const logged = submissions(db);
  assert.deepEqual(logged.map((s) => s.outcome), ['rejected', 'rejected', 'rejected'], 'even unreadable submissions are logged');
  assert.ok(logged.every((s) => s.ip_address === '127.0.0.1'));
  const details = db.prepare('SELECT detail FROM public_submission_log ORDER BY id').all().map((r) => r.detail);
  assert.deepEqual(details.slice(1), ['request body must be valid JSON', 'request body must be a JSON object']);
});

test('unauthorized access: unknown or unpublished items get the same 404, and nothing can be changed', async (t) => {
  const { db, call, stop } = await start();
  t.after(stop);
  const { body: receipt } = await call('POST', '/requests', { body: request() });
  const woId = db.prepare('SELECT work_order_id FROM service_requests WHERE tracking_code = ?').get(receipt.tracking_code).work_order_id;

  const hidden = await call('GET', `/work-orders/${woId}`);
  const missing = await call('GET', '/work-orders/no-such-id');
  assert.equal(hidden.status, 404);
  assert.deepEqual(hidden.body, missing.body, 'a hidden work order looks exactly like a missing one');
  assert.equal((await call('GET', '/requests/HWO-ZZZZZZ')).status, 404);

  for (const [method, path] of [['PATCH', `/work-orders/${woId}`], ['DELETE', `/requests/${receipt.tracking_code}`], ['POST', '/work-orders']]) {
    assert.equal((await call(method, path, { body: {} })).status, 405, `${method} ${path}`);
  }
  assert.equal((await call('GET', '/admin')).status, 404);
});

test('a faked X-Forwarded-For is ignored unless the server is configured to trust a proxy', async (t) => {
  const plain = await start();
  t.after(plain.stop);
  await plain.call('POST', '/requests', { body: request(), headers: { 'X-Forwarded-For': '10.9.9.9' } });
  assert.equal(submissions(plain.db)[0].ip_address, '127.0.0.1');

  const proxied = await start({ trustProxy: true });
  t.after(proxied.stop);
  await proxied.call('POST', '/requests', { body: request(), headers: { 'X-Forwarded-For': '198.51.100.20, 10.0.0.1' } });
  assert.equal(submissions(proxied.db)[0].ip_address, '198.51.100.20');
});

test('spam protection: after 5 accepted requests in an hour, one address gets 429 and it is logged', async (t) => {
  const { db, call, stop } = await start();
  t.after(stop);
  for (let i = 0; i < 5; i += 1) assert.equal((await call('POST', '/requests', { body: request() })).status, 201);
  const sixth = await call('POST', '/requests', { body: request() });
  assert.equal(sixth.status, 429);
  assert.equal(sixth.headers.get('retry-after'), '3600');
  assert.equal(sixth.body.error, 'too_many_requests');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_orders').get().n, 5, 'no sixth work order');
  assert.equal(submissions(db).at(-1).outcome, 'rate_limited');
});

test('data not displayed: if the database is down, the citizen gets a clear 503, not a broken page', async (t) => {
  const { db, call, stop } = await start();
  t.after(stop);
  db.close();
  for (const [method, path, body] of [['GET', '/work-orders'], ['GET', '/requests/HWO-ABCDEF'], ['POST', '/requests', request()]]) {
    const res = await call(method, path, { body });
    assert.equal(res.status, 503, `${method} ${path}`);
    assert.equal(res.body.error, 'database_unavailable');
    assert.match(res.body.message, /Try again later/);
  }
});
