// STORY-007 over real HTTP: an administrator manages access, an auditor reads the audit trail,
// and workflow steps that need a role are enforced.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../server/db.js';
import { createApiClient, READ_SCOPE, WORK_ORDERS_WRITE_SCOPE } from '../server/api/clients.js';
import { createApiServer } from '../server/api/server.js';
import { bootstrapAdministrator, issueUserKey, createUser, grantRole } from '../server/access.js';

async function start() {
  const db = openDatabase();
  const admin = bootstrapAdministrator(db, { email: 'jane.admin@herriman.example', display_name: 'Jane Admin' });
  const adminKey = issueUserKey(db, admin.id, { actorUserId: admin.id }).key;
  const person = (email, name, role) => {
    const user = createUser(db, { email, display_name: name }, { actorUserId: admin.id });
    grantRole(db, { userId: user.id, roleId: role }, { actorUserId: admin.id });
    return { ...user, key: issueUserKey(db, user.id, { actorUserId: admin.id }).key };
  };
  const server = createApiServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (method, path, { key = adminKey, body, headers = {} } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
  };
  return { db, admin, adminKey, person, call, stop: () => new Promise((resolve) => server.close(resolve)) };
}

const pothole = { title: 'Pothole on Main St', work_type: 'pothole', location_text: '5355 W Herriman Main St' };

// ---------- AC1: an administrator assigns roles, and the user gets that access ----------

test('an administrator adds a user, grants a role, issues a key — and the user has exactly that access', async (t) => {
  const { db, admin, call, stop } = await start();
  t.after(stop);
  const added = await call('POST', '/users', { body: { email: 'Lee@Herriman.example', display_name: 'Lee Clerk' } });
  assert.equal(added.status, 201);
  const lee = added.body.item;
  assert.deepEqual(lee.roles, []);

  const issued = await call('POST', `/users/${lee.id}/key`);
  assert.equal(issued.status, 201);
  assert.equal(issued.headers.get('cache-control'), 'no-store');
  const leeKey = issued.body.key;
  assert.equal((await call('POST', '/work-orders', { key: leeKey, body: pothole })).status, 403, 'no role, no access');

  const granted = await call('POST', `/users/${lee.id}/roles`, { body: { role_id: 'clerk' } });
  assert.deepEqual([granted.status, granted.body.changed, granted.body.item.roles], [200, true, ['clerk']]);
  assert.equal((await call('POST', `/users/${lee.id}/roles`, { body: { role_id: 'clerk' } })).body.changed, false, 'same grant twice: no change');
  assert.equal((await call('POST', '/work-orders', { key: leeKey, body: pothole })).status, 201);
  assert.equal((await call('GET', '/heat-maps', { key: leeKey })).status, 403, 'a clerk has no heat maps');

  const removed = await call('DELETE', `/users/${lee.id}/roles/clerk`);
  assert.equal(removed.body.changed, true);
  assert.equal((await call('POST', '/work-orders', { key: leeKey, body: pothole })).status, 403);

  assert.equal((await call('DELETE', `/users/${lee.id}/key`)).body.changed, true);
  assert.equal((await call('GET', '/work-orders', { key: leeKey })).status, 401);

  // Trust: every access change, with the administrator's verified user id and the time.
  const changes = db.prepare("SELECT action, actor_user_id, occurred_at FROM audit_entries WHERE entity_id = ? AND entity_type IN ('user', 'user_role') ORDER BY id").all(lee.id);
  assert.deepEqual(changes.map((c) => c.action), ['create', 'issue_key', 'grant', 'revoke', 'revoke_key']);
  assert.ok(changes.every((c) => c.actor_user_id === admin.id && !Number.isNaN(Date.parse(c.occurred_at))));

  const users = await call('GET', '/users');
  assert.deepEqual(users.body.items.map((u) => u.email), ['jane.admin@herriman.example', 'lee@herriman.example']);
  assert.ok(users.body.items.every((u) => !('key_hash' in u) && !('key_prefix' in u)), 'no key material is ever listed');
  assert.equal((await call('GET', '/roles')).body.items.length, 6);
});

// ---------- failure path: unauthorized access ----------

test('without access:admin — or with only a system key — access cannot be changed; each refusal is audited', async (t) => {
  const { db, person, call, stop } = await start();
  t.after(stop);
  const sam = person('sam@herriman.example', 'Sam Crew', 'field_crew');
  const system = createApiClient(db, { name: 'Rogue integration', scopes: ['access:admin'], actor: 'admin-1' });

  assert.equal((await call('POST', `/users/${sam.id}/roles`, { key: sam.key, body: { role_id: 'system_admin' } })).status, 403, 'nobody promotes themselves');
  assert.equal((await call('POST', '/users', { key: sam.key, body: { email: 'x@herriman.example', display_name: 'Xavier' } })).status, 403);
  assert.equal((await call('GET', '/users', { key: sam.key })).status, 403);
  const bySystem = await call('POST', `/users/${sam.id}/roles`, { key: system.key, body: { role_id: 'system_admin' } });
  assert.equal(bySystem.status, 403, 'access changes must be made by a person');
  assert.match(bySystem.body.message, /must be made by a person/);
  assert.equal((await call('GET', '/users', { key: null })).status, 401);

  const denied = db.prepare("SELECT after_json, actor_user_id FROM audit_entries WHERE entity_type = 'api_access' AND action = 'denied' ORDER BY id").all();
  assert.deepEqual(denied.map((d) => JSON.parse(d.after_json).operation), ['grantRole', 'createUser', 'listUsers', 'grantRole', 'listUsers'], 'the system key refusal is audited too');
  assert.equal(denied[0].actor_user_id, sam.id);
  assert.deepEqual(db.prepare('SELECT role_id FROM user_roles WHERE user_id = ?').all(sam.id).map((r) => r.role_id), ['field_crew']);
});

test('the last active system administrator cannot remove their own role', async (t) => {
  const { admin, call, stop } = await start();
  t.after(stop);
  const res = await call('DELETE', `/users/${admin.id}/roles/system_admin`);
  assert.equal(res.status, 409);
  assert.match(res.body.message, /last active system administrator/);
});

// ---------- AC2: user actions are in the audit trail, and auditors can read it ----------

test('an auditor reads the audit trail filtered by user, item, action and time — and that reading is audited too', async (t) => {
  const { db, admin, person, call, stop } = await start();
  t.after(stop);
  const sam = person('sam@herriman.example', 'Sam Crew', 'field_crew');
  const ava = person('ava@herriman.example', 'Ava Auditor', 'auditor');
  const created = await call('POST', '/work-orders', { key: sam.key, body: pothole });
  await call('PATCH', `/work-orders/${created.body.item.id}`, { key: sam.key, body: { priority: 'high' }, headers: { 'If-Match': '"v1"' } });

  const bySam = await call('GET', `/audit?user_id=${sam.id}&entity_type=work_order`, { key: ava.key });
  assert.equal(bySam.status, 200);
  assert.deepEqual(bySam.body.items.map((e) => e.action), ['create', 'update']);
  assert.ok(bySam.body.items.every((e) => e.actor_user_id === sam.id && e.actor === 'sam@herriman.example'));
  assert.equal(bySam.body.items[1].before.priority, 'normal');
  assert.equal(bySam.body.items[1].after.priority, 'high');

  const grants = await call('GET', '/audit?action=grant&entity_type=user_role', { key: ava.key });
  assert.ok(grants.body.items.length >= 3 && grants.body.items.every((e) => e.action === 'grant'));
  assert.ok(grants.body.items.slice(1).every((e) => e.actor_user_id === admin.id));

  const future = await call('GET', '/audit?from=2099-01-01T00:00:00Z', { key: ava.key });
  assert.deepEqual(future.body.items, []);

  const page1 = await call('GET', '/audit?limit=2', { key: ava.key });
  const page2 = await call('GET', `/audit?limit=2&cursor=${page1.body.next_cursor}`, { key: ava.key });
  assert.equal(page1.body.items.length, 2);
  assert.ok(page2.body.items[0].id > page1.body.items[1].id, 'pages follow on, oldest first');

  assert.equal((await call('GET', '/audit?colour=red', { key: ava.key })).status, 400);
  assert.equal((await call('GET', '/audit', { key: sam.key })).status, 403, 'field crew cannot read the audit trail');

  const reads = db.prepare("SELECT actor_user_id, after_json FROM audit_entries WHERE entity_type = 'api_access' AND action = 'read'").all()
    .filter((r) => JSON.parse(r.after_json).operation === 'readAuditTrail');
  assert.ok(reads.length >= 5 && reads.every((r) => r.actor_user_id === ava.id), 'reading the audit trail is audited, with who read it');
});

// ---------- step roles from STORY-006, now enforced ----------

test('a workflow step that needs a role can only be reached by people holding it', async (t) => {
  const { db, person, call, stop } = await start();
  t.after(stop);
  const sam = person('sam@herriman.example', 'Sam Crew', 'field_crew');
  const sue = person('sue@herriman.example', 'Sue Supervisor', 'supervisor');
  const system = createApiClient(db, { name: 'Crew app', scopes: [READ_SCOPE, WORK_ORDERS_WRITE_SCOPE], actor: 'admin-1' });
  const flow = (stepRoles = {}) => ({
    key: 'pothole_repair', name: 'Pothole repair', work_type: 'pothole',
    steps: [
      { key: 'received', name: 'Received', next: ['repaired'] },
      { key: 'repaired', name: 'Repaired', next: ['inspected'] },
      { key: 'inspected', name: 'Inspected', next: ['completed', 'repaired'], role: stepRoles.inspected },
      { key: 'completed', name: 'Signed off', next: [], final: true, role: stepRoles.completed },
    ],
  });

  const unknownRole = await call('POST', '/workflows', { key: sue.key, body: flow({ inspected: 'inspector' }) });
  assert.equal(unknownRole.status, 422);
  assert.ok(unknownRole.body.problems.includes('role inspector does not exist'));
  assert.equal((await call('POST', '/workflows', { key: sue.key, body: flow({ inspected: 'supervisor', completed: 'supervisor' }) })).status, 201);

  const wo = await call('POST', '/work-orders', { key: sam.key, body: pothole });
  const id = wo.body.item.id;
  const moved = await call('POST', `/work-orders/${id}/transition`, { key: sam.key, body: { to: 'repaired' }, headers: { 'If-Match': '"v1"' } });
  assert.equal(moved.status, 200);
  assert.deepEqual(moved.body.meta.workflow.next_steps, [{ key: 'inspected', name: 'Inspected', role: 'supervisor' }]);

  const crewTries = await call('POST', `/work-orders/${id}/transition`, { key: sam.key, body: { to: 'inspected' }, headers: { 'If-Match': '"v2"' } });
  assert.equal(crewTries.status, 403);
  assert.match(crewTries.body.message, /supervisor role/);
  const refusal = db.prepare("SELECT * FROM audit_entries WHERE entity_type = 'api_access' AND action = 'denied' ORDER BY id DESC").get();
  assert.equal(refusal.actor_user_id, sam.id, 'the refused move is in the audit trail, with who tried');
  assert.equal(refusal.actor, 'sam@herriman.example');
  assert.match(JSON.parse(refusal.after_json).reason, /supervisor role/);
  assert.equal((await call('POST', `/work-orders/${id}/transition`, { key: system.key, body: { actor: 'bot', to: 'inspected' }, headers: { 'If-Match': '"v2"' } })).status, 403, 'a system key is not a person holding a role');

  assert.equal((await call('POST', `/work-orders/${id}/transition`, { key: sue.key, body: { to: 'inspected' }, headers: { 'If-Match': '"v2"' } })).status, 200);
  assert.equal((await call('POST', `/work-orders/${id}/complete`, { key: sam.key, body: { note: 'Done' }, headers: { 'If-Match': '"v3"' } })).status, 403, 'only a supervisor signs off');
  const signed = await call('POST', `/work-orders/${id}/complete`, { key: sue.key, body: { note: 'Inspected and signed off' }, headers: { 'If-Match': '"v3"' } });
  assert.equal(signed.status, 200);
  assert.equal(signed.body.item.status, 'completed');

  const trail = db.prepare("SELECT action, actor_user_id FROM audit_entries WHERE entity_id = ? AND entity_type = 'work_order' ORDER BY id").all(id);
  assert.deepEqual(trail.map((r) => [r.action, r.actor_user_id]), [['create', sam.id], ['transition', sam.id], ['transition', sue.id], ['complete', sue.id]]);
});

// ---------- the first administrator ----------

test('admin:bootstrap sets up the first administrator once, prints the key once, and refuses a second time', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hwo-admin-'));
  const dbPath = join(dir, 'herriman.db');
  try {
    const args = ['--no-warnings', 'server/adminBootstrap.js', '--db', dbPath, '--email', 'jane@herriman.example', '--name', 'Jane Admin'];
    const out = execFileSync(process.execPath, args, { encoding: 'utf8' });
    const key = out.match(/hwu_[0-9a-f]{8}_[A-Za-z0-9_-]+/)?.[0];
    assert.ok(key, 'the key is printed');

    const again = spawnSync(process.execPath, [...args.slice(0, 4), '--email', 'mallory@example.com', '--name', 'Mallory'], { encoding: 'utf8' });
    assert.equal(again.status, 1);
    assert.match(again.stderr, /already exists/);

    assert.ok(!readFileSync(dbPath).includes(key.slice('hwu_'.length + 9)), 'only a hash is stored');
    const db = openDatabase(dbPath);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
