// STORY-004 Trust — every API interaction is logged with timestamps and request details.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../server/db.js';
import { createApiClient, LOCATE_TICKETS_SCOPE } from '../server/api/clients.js';
import { createApiServer } from '../server/api/server.js';
import { createWorkOrder } from '../server/workOrders.js';

async function start() {
  const db = openDatabase();
  await createWorkOrder(db, { title: 'Pothole', work_type: 'pothole', location_text: 'Stand-in site', created_by: 'user-1' });
  const madison = createApiClient(db, { name: 'Madison AI', actor: 'admin-1' });
  const server = createApiServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { key, body } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
      signal: AbortSignal.timeout(5000),
    });
    await res.arrayBuffer();
    return res;
  };
  // The log row is written when the response finishes; give the event loop a moment.
  const logged = async () => {
    await new Promise((r) => setTimeout(r, 20));
    return db.prepare('SELECT * FROM api_request_log ORDER BY id').all();
  };
  return { db, madison, call, logged, stop: () => new Promise((resolve) => server.close(resolve)) };
}

test('a successful keyed read is logged with times, client, method, path, query, status and request id', async (t) => {
  const { madison, call, logged, stop } = await start();
  t.after(stop);
  const res = await call('GET', '/api/v1/work-orders?limit=5', { key: madison.key });
  const [row] = await logged();

  assert.equal(row.request_id, res.headers.get('x-request-id'), 'the caller gets the id to quote');
  assert.equal(row.method, 'GET');
  assert.equal(row.path, '/api/v1/work-orders');
  assert.deepEqual(JSON.parse(row.query_json), { limit: '5' });
  assert.equal(row.client_name, 'Madison AI');
  assert.equal(row.client_ip, '127.0.0.1');
  assert.equal(row.status, 200);
  assert.equal(row.error_code, null);
  assert.ok(Date.parse(row.received_at) <= Date.parse(row.finished_at));
  assert.ok(row.duration_ms >= 0);
});

test('refused, invalid and not-found requests are logged too, with their error codes', async (t) => {
  const { madison, call, logged, stop } = await start();
  t.after(stop);
  await call('GET', '/api/v1/work-orders');
  await call('GET', '/api/v1/work-orders', { key: 'hwo_deadbeef_notarealkeyatall' });
  await call('PATCH', '/api/v1/locate-tickets/x', { key: madison.key, body: { actor: 'x' } });
  await call('GET', '/api/v1/work-orders?limit=0', { key: madison.key });
  await call('GET', '/api/v1/nothing-here');

  assert.deepEqual((await logged()).map((r) => [r.client_name, r.status, r.error_code]), [
    ['anonymous', 401, 'unauthorized'],
    ['invalid key', 401, 'unauthorized'],
    ['Madison AI', 403, 'forbidden'],
    ['Madison AI', 400, 'invalid_request'],
    ['anonymous', 404, 'not_found'],
  ]);
});

test('a request body is logged as field names and size only — never its values', async (t) => {
  const { call, logged, stop } = await start();
  t.after(stop);
  await call('POST', '/api/v1/public/requests', {
    body: {
      description: 'Water leak outside number 12', location_text: 'Stand-in Sample Ave', contact: 'resident@example.com', submission_id: 'log-test-0001',
    },
  });
  const [row] = await logged();
  assert.equal(row.status, 201);
  assert.deepEqual(JSON.parse(row.body_fields), ['description', 'location_text', 'contact', 'submission_id']);
  assert.ok(row.body_bytes > 0);
  const everything = JSON.stringify(row);
  for (const value of ['resident@example.com', 'Water leak', 'Stand-in Sample Ave']) assert.ok(!everything.includes(value), `body value logged: ${value}`);
});

test('an unreadable body is logged with its size and no fields', async (t) => {
  const { call, logged, stop } = await start();
  t.after(stop);
  await call('POST', '/api/v1/public/requests', { body: '{not json' });
  const [row] = await logged();
  assert.equal(row.status, 400);
  assert.equal(row.body_fields, null);
  assert.equal(row.body_bytes, 9);
});

test('no API key ever appears in the request log', async (t) => {
  const { db, madison, call, logged, stop } = await start();
  t.after(stop);
  const writer = createApiClient(db, { name: 'City app', scopes: [LOCATE_TICKETS_SCOPE], actor: 'admin-1' });
  await call('GET', '/api/v1/work-orders', { key: madison.key });
  await call('GET', '/api/v1/locate-tickets/x', { key: writer.key });
  await call('GET', '/api/v1/work-orders', { key: 'hwo_deadbeef_thisisnotarealkey' });
  const everything = JSON.stringify(await logged());
  for (const k of [madison.key, writer.key, 'thisisnotarealkey']) assert.ok(!everything.includes(k));
});

test('the public page and the contract are logged as API interactions as well', async (t) => {
  const { call, logged, stop } = await start();
  t.after(stop);
  await call('GET', '/public');
  await call('GET', '/api/v1/openapi.json');
  assert.deepEqual((await logged()).map((r) => [r.path, r.status]), [['/public', 200], ['/api/v1/openapi.json', 200]]);
});
