// STORY-017 — the administration console: screens over the access, settings and audit APIs. Every test
// goes through a console session, exactly as the screens do, so what passes here is what the console does.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../server/db.js';
import { bootstrapAdministrator, issueUserKey, createUser, grantRole } from '../server/access.js';
import { createApiServer } from '../server/api/server.js';
import { startSession } from '../server/consoleSessions.js';

async function start() {
  const db = openDatabase();
  const admin = bootstrapAdministrator(db, { email: 'jane.admin@herriman.example', display_name: 'Jane Admin' });
  const as = { actorUserId: admin.id };
  const sessionFor = (userId) => startSession(db, issueUserKey(db, userId, as).key).token;
  const person = (email, name, role) => {
    const u = createUser(db, { email, display_name: name }, as);
    if (role) grantRole(db, { userId: u.id, roleId: role }, as);
    return { ...u, token: sessionFor(u.id) };
  };
  const jane = { ...admin, token: sessionFor(admin.id) };
  const sam = person('sam@herriman.example', 'Sam Crew', 'field_crew');
  const sue = person('sue@herriman.example', 'Sue Supervisor', 'supervisor');
  const ava = person('ava@herriman.example', 'Ava Auditor', 'auditor');
  const server = createApiServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (method, path, { token = jane.token, body, headers = {} } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const denials = () => db.prepare("SELECT actor_user_id, after_json FROM audit_entries WHERE entity_type = 'api_access' AND action = 'denied' ORDER BY id").all()
    .map((r) => ({ user: r.actor_user_id, operation: JSON.parse(r.after_json).operation }));
  return { db, jane, sam, sue, ava, call, denials, stop: () => new Promise((resolve) => server.close(resolve)) };
}

// ---------- AC1: an administrator views and changes roles and settings ----------

test('an administrator views users, roles and settings, and changes a role and a setting', async (t) => {
  const { sam, call, stop } = await start();
  t.after(stop);
  const users = await call('GET', '/users');
  assert.deepEqual(users.body.items.map((u) => u.email).sort(), ['ava@herriman.example', 'jane.admin@herriman.example', 'sam@herriman.example', 'sue@herriman.example']);
  assert.ok((await call('GET', '/roles')).body.items.some((r) => r.id === 'planner'));

  const granted = await call('POST', `/users/${sam.id}/roles`, { body: { role_id: 'planner' } });
  assert.deepEqual([granted.status, granted.body.item.roles.sort()], [200, ['field_crew', 'planner']]);
  const removed = await call('DELETE', `/users/${sam.id}/roles/planner`);
  assert.deepEqual(removed.body.item.roles, ['field_crew']);

  const setting = await call('PUT', '/settings/public.rate_limit_per_hour', { body: { value: 12 }, headers: { 'If-Match': '"v0"' } });
  assert.deepEqual([setting.status, setting.body.item.value], [200, 12]);
  const stale = await call('PUT', '/settings/public.rate_limit_per_hour', { body: { value: 20 }, headers: { 'If-Match': '"v0"' } });
  assert.equal(stale.status, 412, 'a stale screen cannot overwrite a newer value');
});

// ---------- AC2: someone who is not an administrator is refused, and the refusal is recorded ----------

test('a field crew member is refused on every administration screen, and each refusal is recorded with who tried', async (t) => {
  const { sam, call, denials, stop } = await start();
  t.after(stop);
  for (const path of ['/users', '/roles', '/settings', '/audit']) {
    assert.equal((await call('GET', path, { token: sam.token })).status, 403, path);
  }
  assert.deepEqual(denials().map((d) => [d.user, d.operation]), [
    [sam.id, 'listUsers'], [sam.id, 'listRoles'], [sam.id, 'listSettings'], [sam.id, 'readAuditTrail'],
  ]);
});

test('an auditor can read the audit trail but is refused on users and settings', async (t) => {
  const { ava, call, stop } = await start();
  t.after(stop);
  assert.equal((await call('GET', '/audit', { token: ava.token })).status, 200);
  assert.equal((await call('GET', '/users', { token: ava.token })).status, 403);
  assert.equal((await call('GET', '/settings', { token: ava.token })).status, 403);
});

// ---------- Trust: no screen can grant what the API would refuse ----------

test('the console cannot grant what the API refuses: a supervisor\'s session cannot grant roles, change settings or deactivate anyone', async (t) => {
  const { sue, sam, call, denials, stop } = await start();
  t.after(stop);
  assert.equal((await call('POST', `/users/${sue.id}/roles`, { token: sue.token, body: { role_id: 'system_admin' } })).status, 403, 'no promoting yourself');
  assert.equal((await call('POST', `/users/${sam.id}/roles`, { token: sue.token, body: { role_id: 'planner' } })).status, 403);
  assert.equal((await call('PUT', '/settings/public.rate_limit_per_hour', { token: sue.token, body: { value: 99 }, headers: { 'If-Match': '"v0"' } })).status, 403);
  assert.equal((await call('POST', `/users/${sam.id}/deactivate`, { token: sue.token, body: {} })).status, 403);
  assert.deepEqual((await call('GET', `/users/${sue.id}`)).body.item.roles, ['supervisor'], 'nothing changed');
  assert.equal(denials().filter((d) => d.user === sue.id).length, 4, 'every attempt recorded');
});

// ---------- failure paths ----------

test('the last administrator cannot remove their own administrator role, or deactivate themselves', async (t) => {
  const { jane, call, stop } = await start();
  t.after(stop);
  const removing = await call('DELETE', `/users/${jane.id}/roles/system_admin`);
  assert.equal(removing.status, 409);
  assert.match(removing.body.message, /last active system administrator/);
  assert.equal((await call('POST', `/users/${jane.id}/deactivate`, { body: {} })).status, 409);
  assert.deepEqual((await call('GET', `/users/${jane.id}`)).body.item.roles, ['system_admin']);
});

test('a role change for a user who no longer exists is refused with 404; for a deactivated user with 409', async (t) => {
  const { sam, call, stop } = await start();
  t.after(stop);
  const missing = await call('POST', '/users/00000000-0000-0000-0000-000000000000/roles', { body: { role_id: 'clerk' } });
  assert.equal(missing.status, 404);
  assert.equal((await call('DELETE', '/users/00000000-0000-0000-0000-000000000000/roles/clerk')).status, 404);
  await call('POST', `/users/${sam.id}/deactivate`, { body: {} });
  const deactivated = await call('POST', `/users/${sam.id}/roles`, { body: { role_id: 'clerk' } });
  assert.equal(deactivated.status, 409);
  assert.match(deactivated.body.message, /deactivated/);
});

// ---------- AC3: every change appears in the audit trail with actor, time and previous value ----------

test('every change made in the console appears in the audit trail with the actor, the time and the previous value', async (t) => {
  const { jane, sam, call, stop } = await start();
  t.after(stop);
  await call('POST', `/users/${sam.id}/roles`, { body: { role_id: 'planner' } });
  await call('PUT', '/settings/public.rate_limit_per_hour', { body: { value: 12 }, headers: { 'If-Match': '"v0"' } });

  const grants = (await call('GET', '/audit?entity_type=user_role&action=grant')).body.items;
  const grant = grants.at(-1);
  assert.deepEqual([grant.actor, grant.actor_user_id, grant.before.roles, grant.after.roles.sort()], ['jane.admin@herriman.example', jane.id, ['field_crew'], ['field_crew', 'planner']]);
  assert.ok(!Number.isNaN(Date.parse(grant.occurred_at)));

  const [setting] = (await call('GET', '/audit?entity_type=setting')).body.items;
  assert.deepEqual([setting.actor_user_id, setting.before.value, setting.after.value], [jane.id, 5, 12], 'previous value and new value');
});

test('an audit trail longer than one page is paged without skipping or repeating', async (t) => {
  const { call, stop } = await start();
  t.after(stop);
  for (let i = 0; i < 12; i += 1) await call('GET', '/users'); // each read is itself recorded
  const seen = [];
  let cursor = '';
  let pages = 0;
  do {
    const page = (await call('GET', `/audit?limit=5${cursor ? `&cursor=${cursor}` : ''}`)).body;
    seen.push(...page.items.map((e) => e.id));
    cursor = page.next_cursor;
    pages += 1;
  } while (cursor && pages < 50);
  assert.ok(pages > 3, 'more than one page');
  assert.equal(new Set(seen).size, seen.length, 'no repeats');
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b), 'oldest first, nothing skipped out of order');
});
