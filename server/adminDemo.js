// STORY-017 demo: the administration console, through a signed-in console session exactly as the
// screens call it. Throwaway in-memory database and local port; nothing is saved.
// To click through the screens themselves: npm run console, sign in as Jane, open Administration.
// Run with: npm run demo:admin

import { openDatabase } from './db.js';
import { bootstrapAdministrator, issueUserKey, createUser, grantRole } from './access.js';
import { createApiServer } from './api/server.js';
import { startSession } from './consoleSessions.js';

const db = openDatabase(':memory:');
const line = () => console.log('-'.repeat(72));
const step = (n, text) => { line(); console.log(`STEP ${n} — ${text}`); line(); };
const admin = bootstrapAdministrator(db, { email: 'jane.admin@herriman.example', display_name: 'Jane Admin' });
const as = { actorUserId: admin.id };
const session = (userId) => startSession(db, issueUserKey(db, userId, as).key).token;
const person = (email, name, role) => {
  const u = createUser(db, { email, display_name: name }, as);
  grantRole(db, { userId: u.id, roleId: role }, as);
  return { ...u, token: session(u.id) };
};
const jane = session(admin.id);
const sam = person('sam@herriman.example', 'Sam Crew', 'field_crew');
const sue = person('sue@herriman.example', 'Sue Supervisor', 'supervisor');

const server = createApiServer(db);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
const call = async (method, path, token, { body, etag } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(etag ? { 'If-Match': etag } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
const show = (label, r, extra = '') => console.log(`  ${label.padEnd(56)} → ${r.status}${r.status >= 400 ? `  ${r.body.message}` : extra}`);

try {
  step(1, 'Jane (administrator) views users and roles, and changes a role and a setting');
  const users = await call('GET', '/users', jane);
  for (const u of users.body.items) console.log(`  ${u.display_name.padEnd(16)} ${u.roles.join(', ')}`);
  show('Jane grants Sam the Planner role', await call('POST', `/users/${sam.id}/roles`, jane, { body: { role_id: 'planner' } }));
  show('Jane sets the public rate limit to 12 per hour', await call('PUT', '/settings/public.rate_limit_per_hour', jane, { body: { value: 12 }, etag: '"v0"' }));
  show('A stale settings screen tries to save 20', await call('PUT', '/settings/public.rate_limit_per_hour', jane, { body: { value: 20 }, etag: '"v0"' }));

  step(2, 'Sam (field crew) opens Administration: refused, and the refusal is recorded');
  for (const path of ['/users', '/settings', '/audit']) show(`Sam opens ${path}`, await call('GET', path, sam.token));

  step(3, 'Trust: no screen can grant what the API would refuse');
  show('Sue (supervisor) tries to make herself an administrator', await call('POST', `/users/${sue.id}/roles`, sue.token, { body: { role_id: 'system_admin' } }));
  show('Sue tries to change the rate limit', await call('PUT', '/settings/public.rate_limit_per_hour', sue.token, { body: { value: 99 }, etag: '"v1"' }));

  step(4, 'Failure paths');
  show('Jane removes her own last administrator role', await call('DELETE', `/users/${admin.id}/roles/system_admin`, jane));
  show('Jane grants a role to a user who no longer exists', await call('POST', '/users/00000000-0000-0000-0000-000000000000/roles', jane, { body: { role_id: 'clerk' } }));

  step(5, 'The audit trail: actor, time and previous value for each change, a page at a time');
  const first = await call('GET', '/audit?limit=5', jane);
  console.log(`  Page 1 of the audit trail: ${first.body.items.length} entries, next page available: ${Boolean(first.body.next_cursor)}`);
  for (const type of ['user_role', 'setting']) {
    for (const e of (await call('GET', `/audit?entity_type=${type}`, jane)).body.items.filter((x) => x.actor_user_id === admin.id)) {
      const was = type === 'setting' ? e.before.value : JSON.stringify(e.before.roles);
      const now = type === 'setting' ? e.after.value : JSON.stringify(e.after.roles);
      console.log(`  ${e.occurred_at}  ${e.actor}  ${type} ${e.action}: previous ${was} → new ${now}`);
    }
  }
  const refused = (await call('GET', '/audit?entity_type=api_access&action=denied', jane)).body.items;
  console.log(`  Refusals recorded: ${refused.length}, e.g. ${refused[0].actor} → ${refused[0].after.operation} (${refused[0].after.reason})`);
  line();
} finally {
  server.close();
}
