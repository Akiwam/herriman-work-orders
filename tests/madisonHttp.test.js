// STORY-011 over real HTTP: a simulated Madison AI crawler against the running API.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../server/db.js';
import { createWorkOrder } from '../server/workOrders.js';
import { createApiClient } from '../server/api/clients.js';
import { createApiServer } from '../server/api/server.js';
import { validateResponse, WORK_ORDER_FIELDS } from '../server/api/workOrderFeed.js';

async function start() {
  const db = openDatabase();
  const ids = [];
  for (const [i, title] of ['Pothole on Example Way', 'Broken streetlight', 'Graffiti on fence', 'Hydrant leaking', 'Blocked drain'].entries()) {
    const wo = await createWorkOrder(db, { title, work_type: 'general', location_text: `Stand-in site ${i + 1}`, created_by: 'user-1' },
      { now: () => new Date(Date.UTC(2026, 9, 30, 9, i)).toISOString() });
    ids.push(wo.id);
  }
  const { key } = createApiClient(db, { name: 'Madison AI', actor: 'admin-1' });
  const server = createApiServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const get = (path, k = key) => fetch(`${base}${path}`, {
    headers: k ? { Authorization: `Bearer ${k}` } : {},
    signal: AbortSignal.timeout(5000),
  });
  const stop = () => new Promise((resolve) => server.close(resolve));
  return { db, ids, key, base, get, stop };
}

/** What a Madison AI indexer does: follow next_cursor until the end, checking every page's format. */
async function crawl(get, limit = 2) {
  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const res = await get(`/work-orders?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(validateResponse(body), [], `page ${pages + 1} is in the published format`);
    seen.push(...body.items.map((i) => i.id));
    cursor = body.next_cursor;
    pages += 1;
  } while (cursor);
  return { seen, pages };
}

const accessAudits = (db) => db.prepare("SELECT action, actor, after_json FROM audit_entries WHERE entity_type = 'api_access' ORDER BY id").all();

test('AC1 + AC2 over HTTP: Madison AI crawls every work order in the published format', async (t) => {
  const { db, ids, get, stop } = await start();
  t.after(stop);
  const { seen, pages } = await crawl(get);
  assert.deepEqual(seen, ids);
  assert.equal(pages, 3);

  // AC3: one audit entry per request, under Madison AI's name
  const audits = accessAudits(db);
  assert.equal(audits.length, 3);
  assert.ok(audits.every((a) => a.action === 'read' && a.actor === 'Madison AI'));
});

test('AC1 over HTTP: search and changes-since return the right records in the right format', async (t) => {
  const { ids, get, stop } = await start();
  t.after(stop);

  const search = await (await get('/work-orders/search?q=streetlight')).json();
  assert.deepEqual(validateResponse(search), []);
  assert.deepEqual(search.items.map((i) => i.id), [ids[1]]);

  const changes = await (await get(`/work-orders/changes?since=${encodeURIComponent('2026-10-30T09:02:30Z')}`)).json();
  assert.deepEqual(validateResponse(changes), []);
  assert.deepEqual(changes.items.map((i) => i.id), [ids[3], ids[4]]);

  const one = await (await get(`/work-orders/${ids[2]}`)).json();
  assert.deepEqual(validateResponse(one), []);
  assert.equal(one.item.title, 'Graffiti on fence');
});

test('responses are JSON and are never cached', async (t) => {
  const { get, stop } = await start();
  t.after(stop);
  const res = await get('/work-orders');
  assert.match(res.headers.get('content-type'), /^application\/json/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('a missing or wrong key gets 401 as JSON, no data, and the refusal is audited', async (t) => {
  const { db, get, stop } = await start();
  t.after(stop);
  for (const k of [null, 'hwo_deadbeef_notarealkeyatall']) {
    const res = await get('/work-orders', k);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('www-authenticate'), 'Bearer');
    const body = await res.json();
    assert.equal(body.error, 'unauthorized');
    assert.equal(body.items, undefined);
  }
  assert.deepEqual(accessAudits(db).map((a) => a.action), ['denied', 'denied']);
});

test('bad parameters, unknown ids, unknown paths and writes get clear JSON errors', async (t) => {
  const { base, key, get, stop } = await start();
  t.after(stop);
  const bad = await get('/work-orders?limit=9999');
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).problems[0], /limit must be/);
  assert.equal((await get('/work-orders/search?q=x')).status, 400);
  assert.equal((await get('/work-orders/changes?since=soon')).status, 400);
  assert.equal((await get('/work-orders/does-not-exist')).status, 404);
  assert.equal((await get('/nothing-here')).status, 404);
  const post = await fetch(`${base}/work-orders`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) });
  assert.equal(post.status, 405, 'the API is read-only');
});

test('the OpenAPI contract is published and matches the fields the feed returns', async (t) => {
  const { get, stop } = await start();
  t.after(stop);
  const res = await get('/openapi.json', null);
  assert.equal(res.status, 200, 'the contract needs no key: it contains no data');
  const doc = await res.json();
  assert.equal(doc.openapi, '3.1.0');
  assert.deepEqual(doc.components.schemas.WorkOrder.required, Object.keys(WORK_ORDER_FIELDS));
  assert.equal(doc.components.schemas.WorkOrder.additionalProperties, false);
  for (const path of ['/work-orders', '/work-orders/changes', '/work-orders/search', '/work-orders/{id}']) assert.ok(doc.paths[path], path);
});

// ---------- failure paths ----------

test('if Madison AI cannot reach the database, it gets 503 with a retry hint and no data', async (t) => {
  const { db, get, stop } = await start();
  t.after(stop);
  db.close();
  const res = await get('/work-orders');
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('retry-after'), '30');
  const body = await res.json();
  assert.equal(body.error, 'database_unavailable');
  assert.equal(body.items, undefined);
});

test('if the audit trail cannot be written, the request gets 503 and no data', async (t) => {
  const { db, get, stop } = await start();
  t.after(stop);
  db.exec('DROP TABLE audit_entries'); // the audit store is gone
  const res = await get('/work-orders');
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error, 'audit_unavailable');
  assert.equal(body.items, undefined);
});
