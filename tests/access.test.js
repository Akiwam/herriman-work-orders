// STORY-007 — users, roles and access: a granted role gives the right access, every change is audited.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase, BUILTIN_ROLES } from '../server/db.js';
import { ValidationError, ConflictError, NotFoundError } from '../server/workOrders.js';
import {
  bootstrapAdministrator, createUser, grantRole, revokeRole, permissionsFor, hasPermission, listRoles, getUser,
  AccessDeniedError, ADMIN_ROLE,
} from '../server/access.js';

function setup() {
  const db = openDatabase();
  const admin = bootstrapAdministrator(db, { email: 'Jane.Admin@herriman.example', display_name: 'Jane Admin' });
  const sam = createUser(db, { email: 'sam@herriman.example', display_name: 'Sam Crew' }, { actorUserId: admin.id });
  return { db, admin, sam };
}
const accessAudits = (db) => db.prepare("SELECT * FROM audit_entries WHERE entity_type IN ('user', 'user_role') ORDER BY id").all();
const failingAudit = () => { throw new Error('audit store unavailable'); };

// ---------- roles ----------

test('the built-in roles are there, and no staff role can submit as a vendor', () => {
  const db = openDatabase();
  const roles = listRoles(db);
  assert.deepEqual(roles.map((r) => r.id).sort(), BUILTIN_ROLES.map(([id]) => id).sort());
  assert.ok(roles.every((r) => !r.permissions.includes('vendor:submit')));
  assert.ok(roles.find((r) => r.id === ADMIN_ROLE).permissions.includes('access:admin'));
});

test('the first administrator is set up once, and only once', () => {
  const { db, admin } = setup();
  assert.equal(admin.email, 'jane.admin@herriman.example', 'emails are stored lower-case');
  assert.deepEqual(admin.roles, [ADMIN_ROLE]);
  assert.throws(() => bootstrapAdministrator(db, { email: 'mallory@example.com', display_name: 'Mallory' }), ConflictError);
});

// ---------- AC1: a granted role gives appropriate access ----------

test('a new user has no access until a role is granted; the role gives exactly its permissions', () => {
  const { db, admin, sam } = setup();
  assert.deepEqual([...permissionsFor(db, sam.id)], []);

  const { changed } = grantRole(db, { userId: sam.id, roleId: 'field_crew' }, { actorUserId: admin.id });
  assert.equal(changed, true);
  assert.deepEqual([...permissionsFor(db, sam.id)].sort(), ['locate_tickets:write', 'work_orders:read', 'work_orders:write']);
  assert.equal(hasPermission(db, sam.id, 'workflows:admin'), false);
  assert.equal(hasPermission(db, sam.id, 'access:admin'), false);

  grantRole(db, { userId: sam.id, roleId: 'planner' }, { actorUserId: admin.id });
  assert.equal(hasPermission(db, sam.id, 'heatmaps:read'), true, 'two roles give the permissions of both');
});

test('removing a role takes the access away straight away', () => {
  const { db, admin, sam } = setup();
  grantRole(db, { userId: sam.id, roleId: 'clerk' }, { actorUserId: admin.id });
  assert.equal(hasPermission(db, sam.id, 'work_orders:write'), true);
  revokeRole(db, { userId: sam.id, roleId: 'clerk' }, { actorUserId: admin.id });
  assert.equal(hasPermission(db, sam.id, 'work_orders:write'), false);
});

test('granting the same role twice, or removing one they do not have, changes nothing', () => {
  const { db, admin, sam } = setup();
  grantRole(db, { userId: sam.id, roleId: 'clerk' }, { actorUserId: admin.id });
  const before = accessAudits(db).length;
  assert.equal(grantRole(db, { userId: sam.id, roleId: 'clerk' }, { actorUserId: admin.id }).changed, false);
  assert.equal(revokeRole(db, { userId: sam.id, roleId: 'planner' }, { actorUserId: admin.id }).changed, false);
  assert.equal(accessAudits(db).length, before);
  assert.deepEqual(getUser(db, sam.id).roles, ['clerk']);
});

// ---------- failure path: unauthorized access ----------

test('only users with access:admin can add users or change roles', () => {
  const { db, admin, sam } = setup();
  grantRole(db, { userId: sam.id, roleId: 'supervisor' }, { actorUserId: admin.id });
  const before = accessAudits(db).length;
  assert.throws(() => grantRole(db, { userId: sam.id, roleId: ADMIN_ROLE }, { actorUserId: sam.id }), AccessDeniedError, 'nobody can promote themselves');
  assert.throws(() => createUser(db, { email: 'x@herriman.example', display_name: 'X' }, { actorUserId: sam.id }), AccessDeniedError);
  assert.throws(() => grantRole(db, { userId: sam.id, roleId: 'clerk' }, {}), AccessDeniedError, 'no user, no access');
  assert.equal(hasPermission(db, sam.id, 'access:admin'), false);
  assert.equal(accessAudits(db).length, before);
});

test('the last active system administrator cannot lose the role', () => {
  const { db, admin, sam } = setup();
  assert.throws(() => revokeRole(db, { userId: admin.id, roleId: ADMIN_ROLE }, { actorUserId: admin.id }), /last active system administrator/);
  grantRole(db, { userId: sam.id, roleId: ADMIN_ROLE }, { actorUserId: admin.id });
  assert.equal(revokeRole(db, { userId: admin.id, roleId: ADMIN_ROLE }, { actorUserId: sam.id }).changed, true, 'fine once there is another');
  assert.throws(() => revokeRole(db, { userId: sam.id, roleId: ADMIN_ROLE }, { actorUserId: sam.id }), /last active system administrator/);
});

test('bad input is refused: unknown user or role, invalid email, duplicate email', () => {
  const { db, admin, sam } = setup();
  assert.throws(() => grantRole(db, { userId: 'nobody', roleId: 'clerk' }, { actorUserId: admin.id }), NotFoundError);
  assert.throws(() => grantRole(db, { userId: sam.id, roleId: 'wizard' }, { actorUserId: admin.id }), NotFoundError);
  assert.throws(() => createUser(db, { email: 'not-an-email', display_name: 'A' }, { actorUserId: admin.id }), ValidationError);
  assert.throws(() => createUser(db, { email: 'SAM@herriman.example', display_name: 'Sam again' }, { actorUserId: admin.id }), ConflictError);
});

// ---------- failure path: access control fails ----------

test('if access cannot be worked out, the answer is no access — never full access', () => {
  const { db, admin } = setup();
  const broken = { prepare() { throw new Error('database is locked'); } };
  const seen = [];
  assert.deepEqual([...permissionsFor(broken, admin.id, { onError: (e) => seen.push(e.message) })], []);
  assert.deepEqual(seen, ['database is locked']);

  db.prepare("UPDATE roles SET permissions_json = '{oops' WHERE id = ?").run(ADMIN_ROLE);
  assert.equal(hasPermission(db, admin.id, 'access:admin'), false, 'unreadable role data denies');
  assert.equal(hasPermission(db, 'unknown-user', 'work_orders:read'), false);

  db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(admin.id);
  db.prepare("UPDATE roles SET permissions_json = '[\"access:admin\"]' WHERE id = ?").run(ADMIN_ROLE);
  assert.equal(hasPermission(db, admin.id, 'access:admin'), false, 'a deactivated user has no access');
});

// ---------- Trust + failure path: audit log not updated ----------

test('every access change is in the audit trail with the user ids and the time', () => {
  const { db, admin, sam } = setup();
  grantRole(db, { userId: sam.id, roleId: 'clerk' }, { actorUserId: admin.id, now: () => '2026-11-02T09:00:00.000Z' });
  revokeRole(db, { userId: sam.id, roleId: 'clerk' }, { actorUserId: admin.id, now: () => '2026-11-02T09:05:00.000Z' });

  const rows = accessAudits(db);
  assert.deepEqual(rows.map((r) => [r.entity_type, r.action]), [
    ['user', 'create'], ['user_role', 'grant'], ['user', 'create'], ['user_role', 'grant'], ['user_role', 'revoke'],
  ]);
  const [grant, revoke] = rows.slice(-2);
  assert.equal(grant.actor_user_id, admin.id);
  assert.equal(grant.entity_id, sam.id);
  assert.equal(grant.occurred_at, '2026-11-02T09:00:00.000Z');
  assert.equal(JSON.parse(grant.after_json).granted, 'clerk');
  assert.equal(revoke.occurred_at, '2026-11-02T09:05:00.000Z');
  assert.deepEqual(JSON.parse(revoke.before_json).roles, ['clerk']);
  assert.deepEqual(JSON.parse(revoke.after_json).roles, []);
});

test('if the audit entry cannot be written, the access change is not made', () => {
  const { db, admin, sam } = setup();
  assert.throws(() => grantRole(db, { userId: sam.id, roleId: 'supervisor' }, { actorUserId: admin.id, audit: failingAudit }), /audit store unavailable/);
  assert.equal(hasPermission(db, sam.id, 'workflows:admin'), false);

  grantRole(db, { userId: sam.id, roleId: 'clerk' }, { actorUserId: admin.id });
  assert.throws(() => revokeRole(db, { userId: sam.id, roleId: 'clerk' }, { actorUserId: admin.id, audit: failingAudit }), /audit store unavailable/);
  assert.equal(hasPermission(db, sam.id, 'work_orders:write'), true, 'the role is still there');

  assert.throws(() => createUser(db, { email: 'new@herriman.example', display_name: 'New' }, { actorUserId: admin.id, audit: failingAudit }));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'new@herriman.example'").get().n, 0);
});
