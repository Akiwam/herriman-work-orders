// STORY-008 over real HTTP: an administrator edits and deactivates users and defines roles; each change
// is felt on the very next request.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../server/db.js';
import { createApiClient } from '../server/api/clients.js';
import { createApiServer } from '../server/api/server.js';
import { bootstrapAdministrator, issueUserKey, createUser, grantRole } from '../server/access.js';

async function start() {
  const db = openDatabase();
  const admin = bootstrapAdministrator(db, { email: 'jane.admin@herriman.example', display_name: 'Jane Admin' });
  const as = { actorUserId: admin.id };
  const adminKey = issueUserKey(db, admin.id, as).key;
  const person = (email, name, role) => {
    const user = createUser(db, { email, display_name: name }, as);
    if (role) grantRole(db, { userId: user.id, roleId: role }, as);
    return { ...user, key: issueUserKey(db, user.id, as).key };
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
  return { db, admin, person, call, stop: () => new Promise((resolve) => server.close(resolve)) };
}

const pothole = { title: 'Pothole on Main St', work_type: 'pothole', location_text: '5355 W Herriman Main St' };

test('a user is edited with If-Match: 428 without it, 412 from an old copy, and the change shows at once', async (t) => {
  const { db, admin, person, call, stop } = await start();
  t.after(stop);
  const sam = person('sam@herriman.example', 'Sam Crew', 'field_crew');
  const read = await call('GET', `/users/${sam.id}`);
  assert.equal(read.headers.get('etag'), '"v1"');

  assert.equal((await call('PATCH', `/users/${sam.id}`, { body: { display_name: 'Samuel Crew' } })).status, 428);
  const edited = await call('PATCH', `/users/${sam.id}`, { body: { display_name: 'Samuel Crew' }, headers: { 'If-Match': '"v1"' } });
  assert.deepEqual([edited.status, edited.body.item.display_name, edited.headers.get('etag')], [200, 'Samuel Crew', '"v2"']);
  const stale = await call('PATCH', `/users/${sam.id}`, { body: { display_name: 'Sammy' }, headers: { 'If-Match': '"v1"' } });
  assert.equal(stale.status, 412);
  assert.equal(stale.body.current.display_name, 'Samuel Crew');
  assert.equal((await call('PATCH', `/users/${sam.id}`, { body: { email: admin.email }, headers: { 'If-Match': '"v2"' } })).status, 409);
  assert.equal((await call('PATCH', `/users/${sam.id}`, { body: { is_active: false }, headers: { 'If-Match': '"v2"' } })).status, 400);

  const [entry] = db.prepare("SELECT actor_user_id, occurred_at FROM audit_entries WHERE entity_type = 'user' AND action = 'update'").all();
  assert.equal(entry.actor_user_id, admin.id);
  assert.ok(!Number.isNaN(Date.parse(entry.occurred_at)));
});

test('a deactivated user is refused on their very next request; reactivated, they need a new key', async (t) => {
  const { admin, person, call, stop } = await start();
  t.after(stop);
  const sam = person('sam@herriman.example', 'Sam Crew', 'field_crew');
  assert.equal((await call('POST', '/work-orders', { key: sam.key, body: pothole })).status, 201);

  const off = await call('POST', `/users/${sam.id}/deactivate`);
  assert.deepEqual([off.status, off.body.changed, off.body.item.is_active], [200, true, false]);
  assert.equal((await call('POST', '/work-orders', { key: sam.key, body: pothole })).status, 401);
  assert.equal((await call('POST', `/users/${sam.id}/deactivate`)).body.changed, false, 'twice: nothing more happens');
  assert.equal((await call('POST', `/users/${admin.id}/deactivate`)).status, 409, 'not yourself');

  await call('POST', `/users/${sam.id}/reactivate`);
  assert.equal((await call('GET', '/work-orders', { key: sam.key })).status, 401, 'the old key stays dead');
  const newKey = (await call('POST', `/users/${sam.id}/key`)).body.key;
  assert.equal((await call('POST', '/work-orders', { key: newKey, body: pothole })).status, 201);
});

test('a role the city defines works on the next request, and so does changing it', async (t) => {
  const { db, admin, person, call, stop } = await start();
  t.after(stop);
  const lee = person('lee@herriman.example', 'Lee Inspector', null);
  const created = await call('POST', '/roles', { body: { id: 'inspector', name: 'Inspector', description: 'Inspects repairs.', permissions: ['work_orders:read', 'work_orders:write'] } });
  assert.equal(created.status, 201);
  await call('POST', `/users/${lee.id}/roles`, { body: { role_id: 'inspector' } });
  assert.equal((await call('POST', '/work-orders', { key: lee.key, body: pothole })).status, 201);

  const narrowed = await call('PATCH', '/roles/inspector', { body: { permissions: ['work_orders:read'] } });
  assert.equal(narrowed.body.changed, true);
  assert.equal((await call('POST', '/work-orders', { key: lee.key, body: pothole })).status, 403, 'write was taken away');
  assert.equal((await call('GET', '/work-orders', { key: lee.key })).status, 200);

  assert.equal((await call('PATCH', '/roles/supervisor', { body: { permissions: ['work_orders:read'] } })).status, 409, 'built-in');
  const badPerm = await call('POST', '/roles', { body: { id: 'flyer', name: 'Flyer', description: 'x', permissions: ['fly'] } });
  assert.equal(badPerm.status, 400);
  assert.match(badPerm.body.problems[0], /fly is not a permission/);
  assert.equal((await call('DELETE', '/roles/inspector')).status, 409, 'Lee still holds it');
  await call('DELETE', `/users/${lee.id}/roles/inspector`);
  assert.equal((await call('DELETE', '/roles/inspector')).status, 200);

  const trail = db.prepare("SELECT action, actor_user_id FROM audit_entries WHERE entity_type = 'role' ORDER BY id").all();
  assert.deepEqual(trail.map((e) => e.action), ['create', 'update', 'delete']);
  assert.ok(trail.every((e) => e.actor_user_id === admin.id));
});

test('without access:admin, or with only a system key, users and roles cannot be managed; refusals are audited', async (t) => {
  const { db, admin, person, call, stop } = await start();
  t.after(stop);
  const sue = person('sue@herriman.example', 'Sue Supervisor', 'supervisor');
  const system = createApiClient(db, { name: 'HR sync', scopes: ['access:admin'], actor: 'admin-1' });
  assert.equal((await call('PATCH', `/users/${admin.id}`, { key: sue.key, body: { display_name: 'X Y' }, headers: { 'If-Match': '"v1"' } })).status, 403);
  assert.equal((await call('POST', `/users/${admin.id}/deactivate`, { key: sue.key })).status, 403);
  assert.equal((await call('POST', '/roles', { key: sue.key, body: { id: 'x_role', name: 'X', description: 'x', permissions: ['audit:read'] } })).status, 403);
  const bySystem = await call('POST', `/users/${sue.id}/deactivate`, { key: system.key });
  assert.equal(bySystem.status, 403);
  assert.match(bySystem.body.message, /must be made by a person/);

  const denied = db.prepare("SELECT after_json FROM audit_entries WHERE entity_type = 'api_access' AND action = 'denied' ORDER BY id").all().map((d) => JSON.parse(d.after_json).operation);
  assert.deepEqual(denied, ['updateUser', 'deactivateUser', 'createRole', 'deactivateUser'], 'the system key refusal is audited too');
  assert.equal((await call('GET', `/users/${admin.id}`)).body.item.is_active, true);
});
