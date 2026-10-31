// STORY-007 over real HTTP: people use personal keys, their roles decide what they can do, and the
// audit trail records their verified user id.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../server/db.js';
import { createApiClient, READ_SCOPE, WORK_ORDERS_WRITE_SCOPE } from '../server/api/clients.js';
import { createApiServer } from '../server/api/server.js';
import { bootstrapAdministrator, createUser, grantRole, revokeRole, issueUserKey, revokeUserKey } from '../server/access.js';

async function start() {
  const db = openDatabase();
  const admin = bootstrapAdministrator(db, { email: 'jane.admin@herriman.example', display_name: 'Jane Admin' });
  const as = { actorUserId: admin.id };
  const person = (email, name, role) => {
    const user = createUser(db, { email, display_name: name }, as);
    if (role) grantRole(db, { userId: user.id, roleId: role }, as);
    return { ...user, key: issueUserKey(db, user.id, as).key };
  };
  const sam = person('sam@herriman.example', 'Sam Crew', 'field_crew');
  const pat = person('pat@herriman.example', 'Pat Planner', 'planner');
  const system = createApiClient(db, { name: 'Crew app', scopes: [READ_SCOPE, WORK_ORDERS_WRITE_SCOPE], actor: 'admin-1' });

  const server = createApiServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (method, path, { key, body, headers = {} } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
  };
  return { db, admin, as, sam, pat, system, call, stop: () => new Promise((resolve) => server.close(resolve)) };
}

const pothole = (extra = {}) => ({ title: 'Pothole on Main St', work_type: 'pothole', location_text: '5355 W Herriman Main St', ...extra });
const auditOf = (db, entityId, action) => db.prepare('SELECT * FROM audit_entries WHERE entity_id = ? AND action = ? ORDER BY id').all(entityId, action);
const denials = (db) => db.prepare("SELECT * FROM audit_entries WHERE entity_type = 'api_access' AND action = 'denied' ORDER BY id").all();

// ---------- AC1: an assigned role gives appropriate access ----------

test('a field crew member can create and complete work orders with their own key, but not run workflows or heat maps', async (t) => {
  const { db, sam, call, stop } = await start();
  t.after(stop);
  const created = await call('POST', '/work-orders', { key: sam.key, body: pothole() });
  assert.equal(created.status, 201, 'no actor needed: the key says who it is');
  const done = await call('POST', `/work-orders/${created.body.item.id}/complete`, { key: sam.key, body: { note: 'Filled' }, headers: { 'If-Match': created.headers.get('etag') } });
  assert.equal(done.status, 200);

  assert.equal((await call('POST', '/workflows', { key: sam.key, body: { key: 'x_flow', name: 'X', work_type: 'x', steps: [] } })).status, 403);
  assert.equal((await call('GET', '/heat-maps', { key: sam.key })).status, 403);
});

test('a planner can see heat maps and read work orders, but not change them', async (t) => {
  const { pat, call, stop } = await start();
  t.after(stop);
  assert.equal((await call('GET', '/heat-maps', { key: pat.key })).status, 200);
  assert.equal((await call('GET', '/work-orders', { key: pat.key })).status, 200);
  assert.equal((await call('POST', '/work-orders', { key: pat.key, body: pothole() })).status, 403);
});

test('granting or removing a role changes what the key can do on the very next request', async (t) => {
  const { db, as, pat, call, stop } = await start();
  t.after(stop);
  assert.equal((await call('POST', '/work-orders', { key: pat.key, body: pothole() })).status, 403);
  grantRole(db, { userId: pat.id, roleId: 'clerk' }, as);
  assert.equal((await call('POST', '/work-orders', { key: pat.key, body: pothole() })).status, 201);
  revokeRole(db, { userId: pat.id, roleId: 'clerk' }, as);
  assert.equal((await call('POST', '/work-orders', { key: pat.key, body: pothole() })).status, 403);
});

// ---------- AC2 + Trust: actions are in the audit trail with the verified user id ----------

test('every action with a personal key is audited with the verified user id and time', async (t) => {
  const { db, sam, call, stop } = await start();
  t.after(stop);
  const created = await call('POST', '/work-orders', { key: sam.key, body: pothole() });
  const id = created.body.item.id;
  await call('PATCH', `/work-orders/${id}`, { key: sam.key, body: { priority: 'high' }, headers: { 'If-Match': '"v1"' } });
  await call('GET', `/work-orders/${id}`, { key: sam.key });

  for (const action of ['create', 'update']) {
    const [row] = auditOf(db, id, action);
    assert.equal(row.actor, 'sam@herriman.example');
    assert.equal(row.actor_user_id, sam.id, `${action} carries the verified user id`);
    assert.ok(!Number.isNaN(Date.parse(row.occurred_at)));
  }
  const read = db.prepare("SELECT * FROM audit_entries WHERE entity_type = 'api_access' AND action = 'read' ORDER BY id DESC").get();
  assert.equal(read.actor_user_id, sam.id, 'reads are attributed too');
});

test('two people acting at the same moment are each recorded as themselves', async (t) => {
  const { db, as, sam, pat, call, stop } = await start();
  t.after(stop);
  grantRole(db, { userId: pat.id, roleId: 'clerk' }, as);
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => {
    const who = i % 2 ? sam : pat;
    return call('POST', '/work-orders', { key: who.key, body: pothole({ title: `Pothole ${i}` }) }).then((r) => ({ who, r }));
  }));
  for (const { who, r } of results) {
    const [row] = auditOf(db, r.body.item.id, 'create');
    assert.equal(row.actor_user_id, who.id);
    assert.equal(row.actor, who.email);
  }
});

test('outside systems keep working as before, with no user id', async (t) => {
  const { db, system, call, stop } = await start();
  t.after(stop);
  const created = await call('POST', '/work-orders', { key: system.key, body: pothole({ actor: 'integration-bot' }) });
  assert.equal(created.status, 201);
  const [row] = auditOf(db, created.body.item.id, 'create');
  assert.equal(row.actor, 'integration-bot via Crew app');
  assert.equal(row.actor_user_id, null);
  assert.equal((await call('POST', '/work-orders', { key: system.key, body: pothole() })).status, 400, 'a system must still say who is acting');
});

// ---------- failure paths: unauthorized access, access control fails ----------

test('nobody can record an action under someone else\'s name', async (t) => {
  const { db, sam, call, stop } = await start();
  t.after(stop);
  const res = await call('POST', '/work-orders', { key: sam.key, body: pothole({ actor: 'jane.admin@herriman.example' }) });
  assert.equal(res.status, 400);
  assert.match(res.body.problems.join(), /actor must be you/);
  const [attempt] = denials(db);
  assert.equal(attempt.actor_user_id, sam.id, 'the attempt is in the audit trail, under who really made it');
  assert.deepEqual(JSON.parse(attempt.after_json), { reason: 'actor is not the signed-in user', claimed_actor: 'jane.admin@herriman.example' });
  assert.equal((await call('POST', '/work-orders', { key: sam.key, body: pothole({ actor: 'SAM@herriman.example' }) })).status, 201, 'their own email is fine');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_orders').get().n, 1);
});

test('refused requests are audited with the user id; replaced, revoked and deactivated keys stop working', async (t) => {
  const { db, as, sam, call, stop } = await start();
  t.after(stop);
  await call('GET', '/heat-maps', { key: sam.key });
  const [denied] = denials(db);
  assert.equal(denied.actor_user_id, sam.id);
  assert.match(JSON.parse(denied.after_json).reason, /missing scope heatmaps:read/);

  const { key: newKey } = issueUserKey(db, sam.id, as);
  assert.equal((await call('GET', '/work-orders', { key: sam.key })).status, 401, 'the old key stopped working');
  assert.equal((await call('GET', '/work-orders', { key: newKey })).status, 200);
  revokeUserKey(db, sam.id, as);
  assert.equal((await call('GET', '/work-orders', { key: newKey })).status, 401);

  const again = issueUserKey(db, sam.id, as).key;
  db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(sam.id);
  assert.equal((await call('GET', '/work-orders', { key: again })).status, 401, 'a deactivated user cannot sign in');
});

test('if roles cannot be read, the key can do nothing (403), and that is audited', async (t) => {
  const { db, sam, call, stop } = await start();
  t.after(stop);
  db.prepare("UPDATE roles SET permissions_json = 'not json' WHERE id = 'field_crew'").run();
  const res = await call('GET', '/work-orders', { key: sam.key });
  assert.equal(res.status, 403);
  assert.equal(denials(db).at(-1).actor_user_id, sam.id);
});

test('personal keys never appear in the database, audit trail or request log', async (t) => {
  const { db, sam, call, stop } = await start();
  t.after(stop);
  await call('POST', '/work-orders', { key: sam.key, body: pothole() });
  const secret = sam.key.slice('hwu_'.length + 9);
  for (const table of ['users', 'audit_entries', 'api_request_log']) {
    const dump = JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all());
    assert.ok(!dump.includes(secret), `${table} must not contain the key`);
  }
  const logged = db.prepare("SELECT client_name FROM api_request_log WHERE method = 'POST'").get();
  assert.equal(logged.client_name, 'sam@herriman.example');
});
