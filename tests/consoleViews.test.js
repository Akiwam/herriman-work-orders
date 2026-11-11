// STORY-014 step 2 — what the console reads: the list (status, assignee, location, paging, empty state)
// and the detail (full history and GIS record on one response, with GIS down handled).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../server/db.js';
import { createWorkOrder, updateWorkOrder, assignWorkOrder } from '../server/workOrders.js';
import { bootstrapAdministrator, issueUserKey, createUser, grantRole } from '../server/access.js';
import { createGisClient, createGisLogger, createStandInGis, loadStandInAssets } from '../server/gis.js';
import { createApiServer } from '../server/api/server.js';

async function start({ gisBackend } = {}) {
  const db = openDatabase();
  const admin = bootstrapAdministrator(db, { email: 'jane.admin@herriman.example', display_name: 'Jane Admin' });
  const as = { actorUserId: admin.id };
  const person = (email, name, role) => {
    const user = createUser(db, { email, display_name: name }, as);
    grantRole(db, { userId: user.id, roleId: role }, as);
    return { ...user, key: issueUserKey(db, user.id, as).key };
  };
  const sam = person('sam@herriman.example', 'Sam Crew', 'field_crew');
  const pat = person('pat@herriman.example', 'Pat Planner', 'planner');
  const backend = gisBackend ?? createStandInGis(loadStandInAssets());
  const gis = createGisClient(backend, { log: createGisLogger(db), timeoutMs: 200, attempts: 2, delayMs: 1 });
  const server = createApiServer(db, { gis });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (path, key = sam.key) => {
    const res = await fetch(`${base}${path}`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(5000) });
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  return { db, gis, sam, pat, call, stop: () => new Promise((resolve) => server.close(resolve)) };
}

test('given work orders exist, each row shows status, assignee and location', async (t) => {
  const { db, sam, call, stop } = await start();
  t.after(stop);
  const a = await createWorkOrder(db, { title: 'Pothole', work_type: 'pothole', location_text: '13400 S Rosecrest Rd (stand-in)', created_by: 'clerk' }, { now: () => '2026-11-01T09:00:00.000Z' });
  await createWorkOrder(db, { title: 'Streetlight out', work_type: 'streetlight', location_text: 'Main St (stand-in)', created_by: 'clerk' }, { now: () => '2026-11-02T09:00:00.000Z' });
  assignWorkOrder(db, a.id, { assigneeUserId: sam.id, actor: 'jane' });

  const res = await call('/console/work-orders');
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 2);
  assert.deepEqual(res.body.items.map((r) => [r.title, r.status, r.assignee?.name ?? 'Unassigned', r.location, r.step]), [
    ['Streetlight out', 'open', 'Unassigned', 'Main St (stand-in)', 'Open'],
    ['Pothole', 'open', 'Sam Crew', '13400 S Rosecrest Rd (stand-in)', 'Open'],
  ], 'newest first');
  assert.equal((await call('/console/work-orders?assignee=unassigned')).body.items.length, 1);
  assert.equal((await call(`/console/work-orders?assignee=${sam.id}`)).body.items[0].title, 'Pothole');
  assert.equal((await call('/console/work-orders?status=completed')).body.total, 0);
});

test('given no work orders, the list is an empty page, not an error', async (t) => {
  const { call, stop } = await start();
  t.after(stop);
  const res = await call('/console/work-orders');
  assert.deepEqual([res.status, res.body.total, res.body.items, res.body.next_cursor], [200, 0, [], null]);
});

test('a list longer than one page is paged without skipping or repeating', async (t) => {
  const { db, call, stop } = await start();
  t.after(stop);
  for (let i = 0; i < 55; i += 1) {
    await createWorkOrder(db, { title: `Job ${i}`, work_type: 'pothole', location_text: 'Stand-in', created_by: 'clerk' }, { now: () => '2026-11-03T09:00:00.000Z' });
  }
  const first = await call('/console/work-orders');
  assert.deepEqual([first.body.total, first.body.items.length, typeof first.body.next_cursor], [55, 50, 'string']);
  const second = await call(`/console/work-orders?cursor=${first.body.next_cursor}`);
  assert.deepEqual([second.body.items.length, second.body.next_cursor], [5, null]);
  const ids = new Set([...first.body.items, ...second.body.items].map((r) => r.id));
  assert.equal(ids.size, 55, 'every work order once, even with identical times');
  assert.equal((await call('/console/work-orders?cursor=garbage&status=closed')).body.problems.length, 2);
});

test('the detail view shows the full history and the live GIS record on one response', async (t) => {
  const { db, gis, sam, call, stop } = await start();
  t.after(stop);
  const wo = await createWorkOrder(db, { title: 'Streetlight out', created_by: 'clerk-1', asset_ids: ['SL-0001'] }, { gis });
  await updateWorkOrder(db, wo.id, { priority: 'high' }, { actor: 'clerk-2' });
  assignWorkOrder(db, wo.id, { assigneeUserId: sam.id, actor: 'supervisor-1' });

  const res = await call(`/console/work-orders/${wo.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('etag'), '"v3"');
  assert.equal(res.body.item.assignee.name, 'Sam Crew');
  assert.deepEqual(res.body.history.map((h) => [h.action, h.by, h.what]), [
    ['create', 'clerk-1', 'Created'],
    ['update', 'clerk-2', 'Changed priority: normal → high'],
    ['assign', 'supervisor-1', 'Assigned: Unassigned → Sam Crew'],
  ]);
  assert.equal(res.body.gis_status, 'live');
  assert.deepEqual([res.body.gis_records[0].id, res.body.gis_records[0].source], ['SL-0001', 'live GIS']);
  assert.ok(res.body.gis_records[0].linked_work_orders, 'the record as GIS holds it now');
});

test('if GIS is unavailable when the detail loads, the saved copy is shown and the rest still works', async (t) => {
  const assets = loadStandInAssets();
  const healthy = createStandInGis(assets);
  let down = false;
  const flaky = { ...healthy, getAsset: (id, auth) => (down ? new Promise(() => {}) : healthy.getAsset(id, auth)) }; // down = never answers
  const { db, gis, call, stop } = await start({ gisBackend: flaky });
  t.after(stop);
  const wo = await createWorkOrder(db, { title: 'Streetlight out', created_by: 'clerk-1', asset_ids: ['SL-0001'] }, { gis });

  down = true;
  const started = Date.now();
  const res = await call(`/console/work-orders/${wo.id}`);
  assert.equal(res.status, 200, 'the screen still loads');
  assert.equal(res.body.gis_status, 'unavailable');
  assert.deepEqual([res.body.gis_records[0].id, res.body.gis_records[0].source], ['SL-0001', 'saved copy']);
  assert.equal(res.body.history.length, 1, 'history still there');
  assert.ok(Date.now() - started < 3000, 'gave up on GIS quickly (timeout and capped retries)');
  const attempts = db.prepare("SELECT COUNT(*) AS n FROM gis_log WHERE operation = 'getAsset' AND outcome != 'ok'").get().n;
  assert.equal(attempts, 2, 'two attempts, then the saved copy');
});

test('the assignee picker lists only people who can work on work orders; reads need a key and are audited', async (t) => {
  const { db, sam, call, stop } = await start();
  t.after(stop);
  const users = await call('/console/users');
  assert.deepEqual(users.body.items.map((u) => u.name), ['Jane Admin', 'Sam Crew'], 'not the planner');
  assert.equal((await call('/console/work-orders', null)).status, 401);
  assert.equal((await call('/console/work-orders/nope')).status, 404);
  const reads = db.prepare("SELECT actor_user_id, after_json FROM audit_entries WHERE action = 'read'").all();
  assert.ok(reads.some((r) => JSON.parse(r.after_json).operation === 'consoleAssignableUsers' && r.actor_user_id === sam.id));
});
