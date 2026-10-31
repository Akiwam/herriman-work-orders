// STORY-008 — managing user accounts and the city's own roles: changes apply at once, are audited,
// and are never half-made.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../server/db.js';
import { ValidationError, ConflictError, NotFoundError } from '../server/workOrders.js';
import {
  bootstrapAdministrator, createUser, grantRole, revokeRole, issueUserKey, userForKey, hasPermission, getUser,
  updateUser, setUserActive, createRole, updateRole, deleteRole, AccessDeniedError, PERMISSIONS,
} from '../server/access.js';
import { publishWorkflow } from '../server/workflows.js';

function setup() {
  const db = openDatabase();
  const admin = bootstrapAdministrator(db, { email: 'jane.admin@herriman.example', display_name: 'Jane Admin' });
  const as = { actorUserId: admin.id };
  const sam = createUser(db, { email: 'sam@herriman.example', display_name: 'Sam Crew' }, as);
  grantRole(db, { userId: sam.id, roleId: 'field_crew' }, as);
  return { db, admin, sam, as };
}
const failing = () => { throw new Error('audit store unavailable'); };
const audits = (db, type) => db.prepare('SELECT * FROM audit_entries WHERE entity_type = ? ORDER BY id').all(type);
const inspector = { id: 'inspector', name: 'Inspector', description: 'Inspects repairs and signs them off.', permissions: ['work_orders:read', 'work_orders:write'] };

// ---------- AC2: a user account, when managed, changes immediately ----------

test('editing a user changes them at once, bumps their version, and is audited without key material', () => {
  const { db, admin, sam, as } = setup();
  const { user, changed } = updateUser(db, sam.id, { display_name: 'Samuel Crew', email: 'Samuel@Herriman.example' }, { ...as, expectedVersion: 1 });
  assert.equal(changed, true);
  assert.deepEqual([user.display_name, user.email, user.version], ['Samuel Crew', 'samuel@herriman.example', 2]);
  assert.equal(updateUser(db, sam.id, { display_name: 'Samuel Crew' }, as).changed, false, 'the same again changes nothing');

  const [entry] = audits(db, 'user').filter((e) => e.action === 'update');
  assert.equal(entry.actor_user_id, admin.id);
  assert.equal(JSON.parse(entry.before_json).email, 'sam@herriman.example');
  assert.equal(JSON.parse(entry.after_json).email, 'samuel@herriman.example');
  assert.ok(!entry.before_json.includes('key_hash') && !entry.after_json.includes('key_hash'));
});

test('a user edit from an out-of-date copy, to a taken email, or with an unknown field is refused', () => {
  const { db, admin, sam, as } = setup();
  updateUser(db, sam.id, { display_name: 'Samuel' }, as);
  assert.throws(() => updateUser(db, sam.id, { display_name: 'Sammy' }, { ...as, expectedVersion: 1 }), { name: 'UserVersionConflictError' });
  assert.throws(() => updateUser(db, sam.id, { email: admin.email }, as), ConflictError);
  assert.throws(() => updateUser(db, sam.id, { is_active: false }, as), ValidationError);
  assert.throws(() => updateUser(db, 'nobody', { display_name: 'X Y' }, as), NotFoundError);
  assert.equal(getUser(db, sam.id).display_name, 'Samuel');
});

test('deactivating a user shuts them out at once; reactivating does not bring their old key back', () => {
  const { db, sam, as } = setup();
  const { key } = issueUserKey(db, sam.id, as);
  assert.ok(userForKey(db, key));
  assert.equal(setUserActive(db, sam.id, false, as).changed, true);
  assert.equal(userForKey(db, key), null, 'the key stops working');
  assert.equal(hasPermission(db, sam.id, 'work_orders:read'), false);
  assert.equal(setUserActive(db, sam.id, false, as).changed, false, 'already deactivated: nothing changes');
  assert.throws(() => grantRole(db, { userId: sam.id, roleId: 'clerk' }, as), /deactivated/);

  setUserActive(db, sam.id, true, as);
  assert.equal(userForKey(db, key), null, 'the old key is gone for good');
  assert.equal(hasPermission(db, sam.id, 'work_orders:read'), true, 'their roles were kept');
  assert.ok(userForKey(db, issueUserKey(db, sam.id, as).key), 'a new key works');
  assert.deepEqual(audits(db, 'user').map((e) => e.action).filter((a) => /activate/.test(a)), ['deactivate', 'reactivate']);
});

test('nobody can deactivate themselves, and the last active system administrator cannot be deactivated', () => {
  const { db, admin, as } = setup();
  assert.throws(() => setUserActive(db, admin.id, false, as), /cannot deactivate yourself/);
  createRole(db, { id: 'access_desk', name: 'Access desk', description: 'Manages who has access.', permissions: ['access:admin'] }, as);
  const lee = createUser(db, { email: 'lee@herriman.example', display_name: 'Lee Desk' }, as);
  grantRole(db, { userId: lee.id, roleId: 'access_desk' }, as);
  assert.throws(() => setUserActive(db, admin.id, false, { actorUserId: lee.id }), /last active system administrator/);
  assert.equal(getUser(db, admin.id).is_active, true);
});

// ---------- the city's own roles ----------

test('an administrator defines a role; granting it gives exactly its permissions; changing it applies at once', () => {
  const { db, admin, sam, as } = setup();
  const role = createRole(db, inspector, as);
  assert.deepEqual(role.permissions, ['work_orders:read', 'work_orders:write']);
  revokeRole(db, { userId: sam.id, roleId: 'field_crew' }, as);
  grantRole(db, { userId: sam.id, roleId: 'inspector' }, as);
  assert.equal(hasPermission(db, sam.id, 'work_orders:write'), true);

  const { changed } = updateRole(db, 'inspector', { permissions: ['work_orders:read'] }, as);
  assert.equal(changed, true);
  assert.equal(hasPermission(db, sam.id, 'work_orders:write'), false, 'everyone holding it loses write at once');
  assert.equal(updateRole(db, 'inspector', { permissions: ['work_orders:read'] }, as).changed, false);

  const trail = audits(db, 'role');
  assert.deepEqual(trail.map((e) => e.action), ['create', 'update']);
  assert.ok(trail.every((e) => e.actor_user_id === admin.id));
  assert.deepEqual(JSON.parse(trail[1].before_json).permissions, ['work_orders:read', 'work_orders:write']);
});

test('bad roles are refused with every problem listed; built-in roles cannot be changed or deleted', () => {
  const { db, as } = setup();
  assert.throws(() => createRole(db, { ...inspector, permissions: ['work_orders:read', 'fly', 'vendor:submit'] }, as),
    (err) => err instanceof ValidationError && err.problems.length === 2 && err.problems.every((p) => /is not a permission/.test(p)));
  assert.throws(() => createRole(db, { ...inspector, id: 'Bad Id' }, as), /id must be/);
  assert.throws(() => createRole(db, { ...inspector, permissions: [] }, as), /at least one permission/);
  assert.throws(() => createRole(db, { ...inspector, id: 'clerk' }, as), ConflictError);
  assert.throws(() => updateRole(db, 'supervisor', { permissions: ['work_orders:read'] }, as), /built-in role/);
  assert.throws(() => deleteRole(db, 'auditor', as), /built-in role/);
  assert.ok(!PERMISSIONS.includes('vendor:submit'), 'vendor submission is never a staff permission');
});

test('a role cannot be deleted while someone holds it or a workflow step needs it', () => {
  const { db, sam, as } = setup();
  createRole(db, inspector, as);
  grantRole(db, { userId: sam.id, roleId: 'inspector' }, as);
  assert.throws(() => deleteRole(db, 'inspector', as), /still hold/);
  revokeRole(db, { userId: sam.id, roleId: 'inspector' }, as);
  publishWorkflow(db, {
    key: 'pothole_repair', name: 'Pothole repair', work_type: 'pothole',
    steps: [{ key: 'received', name: 'Received', next: ['completed'] }, { key: 'completed', name: 'Signed off', next: [], final: true, role: 'inspector' }],
  }, { actorUserId: as.actorUserId, actor: 'jane' });
  assert.throws(() => deleteRole(db, 'inspector', as), /workflow step/);
});

test('a role nobody uses can be deleted, and that is audited', () => {
  const { db, admin, as } = setup();
  createRole(db, inspector, as);
  assert.deepEqual(deleteRole(db, 'inspector', as), { deleted: 'inspector' });
  const [, del] = audits(db, 'role');
  assert.deepEqual([del.action, del.actor_user_id], ['delete', admin.id]);
});

// ---------- failure paths: user management error, unauthorized access ----------

test('if the audit entry cannot be written, no user or role change is made', () => {
  const { db, sam, as } = setup();
  const failAs = { ...as, audit: failing };
  assert.throws(() => updateUser(db, sam.id, { display_name: 'Changed' }, failAs), /audit store unavailable/);
  assert.throws(() => setUserActive(db, sam.id, false, failAs), /audit store unavailable/);
  assert.throws(() => createRole(db, inspector, failAs), /audit store unavailable/);
  const user = getUser(db, sam.id);
  assert.deepEqual([user.display_name, user.is_active, user.version], ['Sam Crew', true, 1]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM roles WHERE id = 'inspector'").get().n, 0);

  createRole(db, inspector, as);
  assert.throws(() => updateRole(db, 'inspector', { permissions: ['audit:read'] }, failAs), /audit store unavailable/);
  assert.throws(() => deleteRole(db, 'inspector', failAs), /audit store unavailable/);
  assert.deepEqual(JSON.parse(db.prepare("SELECT permissions_json FROM roles WHERE id = 'inspector'").get().permissions_json), ['work_orders:read', 'work_orders:write']);
});

test('only people with access:admin can manage users and roles', () => {
  const { db, admin, sam } = setup();
  const bySam = { actorUserId: sam.id };
  assert.throws(() => updateUser(db, admin.id, { display_name: 'Hacked' }, bySam), AccessDeniedError);
  assert.throws(() => setUserActive(db, admin.id, false, bySam), AccessDeniedError);
  assert.throws(() => createRole(db, inspector, bySam), AccessDeniedError);
  assert.throws(() => updateRole(db, 'inspector', {}, {}), AccessDeniedError, 'no user, no change');
  assert.equal(getUser(db, admin.id).display_name, 'Jane Admin');
});
