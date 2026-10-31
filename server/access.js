// Users, roles and access (STORY-007, REQ-047).
//
// A user's access is the union of the permissions of the roles they hold. Granting or removing a
// role takes effect on their next request — nothing is cached. Only users with access:admin may
// change roles, and every change is saved together with its audit entry (who, for whom, which role,
// when), or not at all.
//
// Two rules keep this safe:
//   - Fail closed: if a user's access cannot be worked out for any reason (database error, unknown
//     user, deactivated user), the answer is "no access", never "full access".
//   - The last active system administrator cannot lose that role, so the city can never be locked
//     out of managing access.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { inTransaction } from './db.js';
import { writeAudit, ValidationError, ConflictError, NotFoundError } from './workOrders.js';

export const ADMIN_ROLE = 'system_admin';
export const ACCESS_ADMIN = 'access:admin';
export const AUDIT_READ = 'audit:read';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const defaultNow = () => new Date().toISOString();

/** The user is not allowed to do this. Nothing was changed. */
export class AccessDeniedError extends Error {
  constructor(permission) {
    super(`You do not have permission to do this (needs ${permission})`);
    this.name = 'AccessDeniedError';
    this.permission = permission;
  }
}

const notFound = (what) => {
  const err = new NotFoundError(what);
  err.message = `No ${what}`;
  return err;
};

// ---------- reading ----------

export function getUser(db, id) {
  const u = db.prepare('SELECT id, email, display_name, is_active, created_by, created_at, version FROM users WHERE id = ?').get(String(id ?? ''));
  return u ? { ...u, is_active: u.is_active === 1, roles: rolesOf(db, u.id) } : null;
}

export function rolesOf(db, userId) {
  return db.prepare('SELECT role_id FROM user_roles WHERE user_id = ? ORDER BY role_id').all(userId).map((r) => r.role_id);
}

export function listRoles(db) {
  return db.prepare('SELECT * FROM roles ORDER BY is_builtin DESC, id').all()
    .map((r) => ({ id: r.id, name: r.name, description: r.description, permissions: JSON.parse(r.permissions_json), builtin: r.is_builtin === 1 }));
}

/**
 * Everything this user may do, as a Set of permission names. Fails closed: an unknown or
 * deactivated user, or any error while looking it up, gives an empty set.
 * `onError` lets the caller record why a check failed (it must not throw).
 */
export function permissionsFor(db, userId, { onError = () => {} } = {}) {
  try {
    const user = db.prepare('SELECT is_active FROM users WHERE id = ?').get(String(userId ?? ''));
    if (!user || user.is_active !== 1) return new Set();
    const rows = db.prepare(`SELECT r.permissions_json FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?`).all(userId);
    const permissions = new Set();
    for (const r of rows) {
      const list = JSON.parse(r.permissions_json);
      if (!Array.isArray(list)) throw new Error(`role permissions are not a list`);
      for (const p of list) if (typeof p === 'string') permissions.add(p);
    }
    return permissions;
  } catch (err) {
    try { onError(err); } catch { /* recording the failure must not turn a "no" into an error */ }
    return new Set();
  }
}

export const hasPermission = (db, userId, permission, opts) => permissionsFor(db, userId, opts).has(permission);

function requirePermission(db, actorUserId, permission) {
  if (!hasPermission(db, actorUserId, permission)) throw new AccessDeniedError(permission);
  return db.prepare('SELECT id, email FROM users WHERE id = ?').get(actorUserId);
}

// ---------- users ----------

function cleanUser(input) {
  const problems = [];
  const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : '';
  const name = typeof input?.display_name === 'string' ? input.display_name.trim() : '';
  if (!EMAIL.test(email)) problems.push('a valid email is required');
  if (name.length < 2 || name.length > 100) problems.push('display_name must be 2 to 100 characters');
  if (problems.length) throw new ValidationError(problems);
  return { email, display_name: name };
}

function insertUser(db, fields, createdBy, at) {
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(fields.email)) throw new ConflictError(`A user with email ${fields.email} already exists`);
  const row = { id: randomUUID(), ...fields, is_active: 1, created_by: createdBy, created_at: at };
  db.prepare(`INSERT INTO users (id, email, display_name, is_active, created_by, created_at)
              VALUES (:id, :email, :display_name, :is_active, :created_by, :created_at)`).run(row);
  return row;
}

/**
 * Set up the first system administrator. Only works while nobody holds that role, so it cannot be
 * used to take over a running system. Recorded in the audit trail as done by 'system'.
 */
export function bootstrapAdministrator(db, input, { now = defaultNow, audit = writeAudit } = {}) {
  const fields = cleanUser(input);
  return inTransaction(db, () => {
    const existing = db.prepare('SELECT COUNT(*) AS n FROM user_roles WHERE role_id = ?').get(ADMIN_ROLE).n;
    if (existing) throw new ConflictError('A system administrator already exists; ask them to add you.');
    const at = now();
    const user = insertUser(db, fields, 'system', at);
    db.prepare('INSERT INTO user_roles (user_id, role_id, granted_by, granted_at) VALUES (?, ?, ?, ?)').run(user.id, ADMIN_ROLE, 'system', at);
    audit(db, { entityType: 'user', entityId: user.id, action: 'create', actor: 'system (first administrator)', after: user, at });
    audit(db, {
      entityType: 'user_role', entityId: user.id, action: 'grant', actor: 'system (first administrator)',
      before: { user_id: user.id, roles: [] }, after: { user_id: user.id, roles: [ADMIN_ROLE], granted: ADMIN_ROLE }, at,
    });
    return getUser(db, user.id);
  });
}

/** An administrator adds a user, with no roles: they can do nothing until a role is granted. */
export function createUser(db, input, { actorUserId, now = defaultNow, audit = writeAudit } = {}) {
  return inTransaction(db, () => {
    // Permission first: someone without it learns nothing, not even whether their input was valid.
    const actor = requirePermission(db, actorUserId, ACCESS_ADMIN);
    const fields = cleanUser(input);
    const at = now();
    const user = insertUser(db, fields, actor.id, at);
    audit(db, { entityType: 'user', entityId: user.id, action: 'create', actor: actor.email, actorUserId: actor.id, after: user, at });
    return getUser(db, user.id);
  });
}

// ---------- personal keys ----------
//
// Keys look like  hwu_<prefix>_<secret>  (hwu = user; outside systems' keys are hwo_). Only the prefix
// and a sha256 hash are stored. The key is returned once, from issueUserKey, and never written
// anywhere else — not the database, not the audit trail, not the logs.

const USER_KEY = /^hwu_([0-9a-f]{8})_[A-Za-z0-9_-]+$/;
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** Give a user a new personal key, replacing any key they had. The old one stops working at once. */
export function issueUserKey(db, userId, { actorUserId, now = defaultNow, audit = writeAudit } = {}) {
  return inTransaction(db, () => {
    const actor = requirePermission(db, actorUserId, ACCESS_ADMIN);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(String(userId ?? ''));
    if (!user) throw notFound(`user ${userId}`);
    if (user.is_active !== 1) throw new ConflictError(`${user.email} is deactivated; no key can be issued.`);
    const prefix = randomBytes(4).toString('hex');
    const key = `hwu_${prefix}_${randomBytes(24).toString('base64url')}`;
    const at = now();
    db.prepare('UPDATE users SET key_prefix = ?, key_hash = ? WHERE id = ?').run(prefix, sha256(key), user.id);
    audit(db, {
      entityType: 'user', entityId: user.id, action: 'issue_key', actor: actor.email, actorUserId: actor.id,
      before: { had_key: Boolean(user.key_hash) }, after: { key_prefix: prefix }, at, // the prefix only, never the key
    });
    return { user: getUser(db, user.id), key };
  });
}

/** Stop a user's personal key from working. Safe to repeat. */
export function revokeUserKey(db, userId, { actorUserId, now = defaultNow, audit = writeAudit } = {}) {
  return inTransaction(db, () => {
    const actor = requirePermission(db, actorUserId, ACCESS_ADMIN);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(String(userId ?? ''));
    if (!user) throw notFound(`user ${userId}`);
    if (!user.key_hash) return { changed: false };
    const at = now();
    db.prepare('UPDATE users SET key_prefix = NULL, key_hash = NULL WHERE id = ?').run(user.id);
    audit(db, { entityType: 'user', entityId: user.id, action: 'revoke_key', actor: actor.email, actorUserId: actor.id, before: { key_prefix: user.key_prefix }, at });
    return { changed: true };
  });
}

/** The active user a personal key belongs to, or null. Constant-time comparison of the hash. */
export function userForKey(db, presentedKey) {
  const match = USER_KEY.exec(String(presentedKey ?? ''));
  if (!match) return null;
  const row = db.prepare('SELECT * FROM users WHERE key_prefix = ?').get(match[1]);
  if (!row || row.is_active !== 1 || !row.key_hash) return null;
  const given = Buffer.from(sha256(presentedKey), 'hex');
  const stored = Buffer.from(row.key_hash, 'hex');
  return given.length === stored.length && timingSafeEqual(given, stored) ? { id: row.id, email: row.email, display_name: row.display_name } : null;
}

export const looksLikeUserKey = (key) => String(key ?? '').startsWith('hwu_');

// ---------- roles ----------

function checkTarget(db, userId, roleId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(String(userId ?? ''));
  if (!user) throw notFound(`user ${userId}`);
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(String(roleId ?? ''));
  if (!role) throw notFound(`role ${roleId}`);
  return { user, role };
}

/**
 * Give a user a role. Granting a role they already have changes nothing and writes no audit entry
 * (returns changed: false), so sending the same grant twice is safe.
 */
export function grantRole(db, { userId, roleId }, { actorUserId, now = defaultNow, audit = writeAudit } = {}) {
  return inTransaction(db, () => {
    const actor = requirePermission(db, actorUserId, ACCESS_ADMIN);
    const { user, role } = checkTarget(db, userId, roleId);
    if (user.is_active !== 1) throw new ConflictError(`${user.email} is deactivated; roles cannot be granted to them.`);
    const before = rolesOf(db, user.id);
    if (before.includes(role.id)) return { user: getUser(db, user.id), changed: false };

    const at = now();
    db.prepare('INSERT INTO user_roles (user_id, role_id, granted_by, granted_at) VALUES (?, ?, ?, ?)').run(user.id, role.id, actor.id, at);
    audit(db, {
      entityType: 'user_role', entityId: user.id, action: 'grant', actor: actor.email, actorUserId: actor.id,
      before: { user_id: user.id, roles: before }, after: { user_id: user.id, roles: rolesOf(db, user.id), granted: role.id }, at,
    });
    return { user: getUser(db, user.id), changed: true };
  });
}

/**
 * Take a role away. Removing a role the user does not have changes nothing (changed: false).
 * The last active system administrator cannot lose that role.
 */
export function revokeRole(db, { userId, roleId }, { actorUserId, now = defaultNow, audit = writeAudit } = {}) {
  return inTransaction(db, () => {
    const actor = requirePermission(db, actorUserId, ACCESS_ADMIN);
    const { user, role } = checkTarget(db, userId, roleId);
    const before = rolesOf(db, user.id);
    if (!before.includes(role.id)) return { user: getUser(db, user.id), changed: false };

    if (role.id === ADMIN_ROLE) {
      const admins = db.prepare(`SELECT COUNT(*) AS n FROM user_roles ur JOIN users u ON u.id = ur.user_id
                                 WHERE ur.role_id = ? AND u.is_active = 1`).get(ADMIN_ROLE).n;
      if (admins <= 1 && user.is_active === 1) {
        throw new ConflictError('This is the last active system administrator. Make someone else an administrator first.');
      }
    }
    const at = now();
    db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ?').run(user.id, role.id);
    audit(db, {
      entityType: 'user_role', entityId: user.id, action: 'revoke', actor: actor.email, actorUserId: actor.id,
      before: { user_id: user.id, roles: before }, after: { user_id: user.id, roles: rolesOf(db, user.id), revoked: role.id }, at,
    });
    return { user: getUser(db, user.id), changed: true };
  });
}

// ---------- user management (STORY-008) ----------

/**
 * The caller's copy of the user is out of date: someone else changed it. Nothing was changed.
 * A ConflictError named UserVersionConflictError. (Made by a function, not `class … extends ConflictError`:
 * this module and workOrders.js import each other, so ConflictError does not exist yet while this file loads.)
 */
export function userVersionConflict(expectedVersion, currentVersion) {
  const err = new ConflictError(`This user has changed since you read them (you had version ${expectedVersion}, it is now version ${currentVersion}). Read them again and retry.`);
  err.name = 'UserVersionConflictError';
  err.currentVersion = currentVersion;
  return err;
}

function loadForChange(db, userId, expectedVersion) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(String(userId ?? ''));
  if (!user) throw notFound(`user ${userId}`);
  if (expectedVersion !== undefined && user.version !== expectedVersion) throw userVersionConflict(expectedVersion, user.version);
  return user;
}

const publicUserRow = ({ key_hash: _h, key_prefix: _p, ...rest }) => rest; // key material never goes in the audit trail

/** Change a user's email or display name. Nothing to change → changed: false, no audit entry. */
export function updateUser(db, userId, changes, { actorUserId, expectedVersion, now = defaultNow, audit = writeAudit } = {}) {
  return inTransaction(db, () => {
    const actor = requirePermission(db, actorUserId, ACCESS_ADMIN);
    const unknown = Object.keys(changes ?? {}).filter((f) => !['email', 'display_name'].includes(f));
    if (unknown.length) throw new ValidationError(unknown.map((f) => `${f} cannot be changed here`));
    const before = loadForChange(db, userId, expectedVersion);
    const merged = cleanUser({ email: changes.email ?? before.email, display_name: changes.display_name ?? before.display_name });
    const changed = ['email', 'display_name'].filter((f) => merged[f] !== before[f]);
    if (!changed.length) return { user: getUser(db, before.id), changed: false };
    if (changed.includes('email') && db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(merged.email, before.id)) {
      throw new ConflictError(`A user with email ${merged.email} already exists`);
    }
    const at = now();
    db.prepare('UPDATE users SET email = ?, display_name = ?, version = version + 1 WHERE id = ?').run(merged.email, merged.display_name, before.id);
    audit(db, {
      entityType: 'user', entityId: before.id, action: 'update', actor: actor.email, actorUserId: actor.id,
      before: publicUserRow(before), after: publicUserRow(db.prepare('SELECT * FROM users WHERE id = ?').get(before.id)), at,
    });
    return { user: getUser(db, before.id), changed: true };
  });
}

/**
 * Deactivate or reactivate a user. Deactivating removes their key, so they are refused on their very
 * next request; reactivating does not bring the old key back — issue a new one. Nobody can deactivate
 * themselves, and the last active system administrator cannot be deactivated.
 */
export function setUserActive(db, userId, active, { actorUserId, expectedVersion, now = defaultNow, audit = writeAudit } = {}) {
  return inTransaction(db, () => {
    const actor = requirePermission(db, actorUserId, ACCESS_ADMIN);
    const before = loadForChange(db, userId, expectedVersion);
    if ((before.is_active === 1) === active) return { user: getUser(db, before.id), changed: false };
    if (!active) {
      if (before.id === actor.id) throw new ConflictError('You cannot deactivate yourself. Ask another administrator.');
      const isAdmin = rolesOf(db, before.id).includes(ADMIN_ROLE);
      const admins = db.prepare(`SELECT COUNT(*) AS n FROM user_roles ur JOIN users u ON u.id = ur.user_id
                                 WHERE ur.role_id = ? AND u.is_active = 1`).get(ADMIN_ROLE).n;
      if (isAdmin && admins <= 1) throw new ConflictError('This is the last active system administrator and cannot be deactivated.');
    }
    const at = now();
    db.prepare(`UPDATE users SET is_active = ?, version = version + 1${active ? '' : ', key_prefix = NULL, key_hash = NULL'} WHERE id = ?`)
      .run(active ? 1 : 0, before.id);
    audit(db, {
      entityType: 'user', entityId: before.id, action: active ? 'reactivate' : 'deactivate', actor: actor.email, actorUserId: actor.id,
      before: { is_active: before.is_active === 1, had_key: Boolean(before.key_hash), version: before.version },
      // a deactivated user's key is removed; reactivating needs a new one
      after: { is_active: active, had_key: false, version: before.version + 1 }, at,
    });
    return { user: getUser(db, before.id), changed: true };
  });
}

// ---------- roles the city defines (STORY-008) ----------

/** Every permission a role can include. vendor:submit is left out on purpose: it is for outside vendors only. */
export const PERMISSIONS = [
  'work_orders:read', 'work_orders:write', 'workflows:admin', 'heatmaps:read', 'locate_tickets:write',
  'vendor:review', 'access:admin', 'audit:read', 'settings:admin',
];
const ROLE_ID = /^[a-z][a-z0-9_]{1,40}$/;

function cleanRole(input, { partial = false } = {}) {
  const problems = [];
  const out = {};
  const unknown = Object.keys(input ?? {}).filter((f) => !['id', 'name', 'description', 'permissions'].includes(f));
  problems.push(...unknown.map((f) => `${f} is not a role field`));
  if (!partial || input.name !== undefined) {
    out.name = typeof input?.name === 'string' ? input.name.trim() : '';
    if (out.name.length < 2 || out.name.length > 60) problems.push('name must be 2 to 60 characters');
  }
  if (!partial || input.description !== undefined) {
    out.description = typeof input?.description === 'string' ? input.description.trim() : '';
    if (!out.description || out.description.length > 300) problems.push('description must be 1 to 300 characters');
  }
  if (!partial || input.permissions !== undefined) {
    const list = input?.permissions;
    if (!Array.isArray(list) || !list.length) problems.push('permissions must be a list with at least one permission');
    else {
      for (const p of list) if (!PERMISSIONS.includes(p)) problems.push(`${String(p)} is not a permission; use ${PERMISSIONS.join(', ')}`);
      if (new Set(list).size !== list.length) problems.push('a permission is listed twice');
      out.permissions = [...list].sort();
    }
  }
  if (problems.length) throw new ValidationError(problems);
  return out;
}

const roleRow = (db, id) => db.prepare('SELECT * FROM roles WHERE id = ?').get(String(id ?? ''));
const roleView = (r) => ({ id: r.id, name: r.name, description: r.description, permissions: JSON.parse(r.permissions_json), builtin: r.is_builtin === 1 });

function editableRole(db, roleId) {
  const role = roleRow(db, roleId);
  if (!role) throw notFound(`role ${roleId}`);
  if (role.is_builtin === 1) throw new ConflictError(`${role.name} is a built-in role and cannot be changed. Create a role of your own instead.`);
  return role;
}

/** An administrator defines a role of their own, from the known permissions. */
export function createRole(db, input, { actorUserId, now = defaultNow, audit = writeAudit } = {}) {
  return inTransaction(db, () => {
    const actor = requirePermission(db, actorUserId, ACCESS_ADMIN);
    const fields = cleanRole(input);
    const id = typeof input?.id === 'string' ? input.id.trim() : '';
    if (!ROLE_ID.test(id)) throw new ValidationError(['id must be 2 to 41 lowercase letters, digits or _ and start with a letter']);
    if (roleRow(db, id)) throw new ConflictError(`A role with id ${id} already exists`);
    if (db.prepare('SELECT 1 FROM roles WHERE name = ?').get(fields.name)) throw new ConflictError(`A role named ${fields.name} already exists`);
    db.prepare('INSERT INTO roles (id, name, description, permissions_json, is_builtin) VALUES (?, ?, ?, ?, 0)')
      .run(id, fields.name, fields.description, JSON.stringify(fields.permissions));
    const role = roleView(roleRow(db, id));
    audit(db, { entityType: 'role', entityId: id, action: 'create', actor: actor.email, actorUserId: actor.id, after: role, at: now() });
    return role;
  });
}

/** Change a role of the city's own. New permissions apply to everyone holding it on their next request. */
export function updateRole(db, roleId, changes, { actorUserId, now = defaultNow, audit = writeAudit } = {}) {
  return inTransaction(db, () => {
    const actor = requirePermission(db, actorUserId, ACCESS_ADMIN);
    const before = editableRole(db, roleId);
    if (changes && 'id' in changes) throw new ValidationError(['a role id cannot be changed']);
    const fields = cleanRole(changes, { partial: true });
    const merged = {
      name: fields.name ?? before.name, description: fields.description ?? before.description,
      permissions_json: fields.permissions ? JSON.stringify(fields.permissions) : before.permissions_json,
    };
    if (merged.name === before.name && merged.description === before.description && merged.permissions_json === before.permissions_json) {
      return { role: roleView(before), changed: false };
    }
    if (merged.name !== before.name && db.prepare('SELECT 1 FROM roles WHERE name = ? AND id != ?').get(merged.name, before.id)) {
      throw new ConflictError(`A role named ${merged.name} already exists`);
    }
    db.prepare('UPDATE roles SET name = ?, description = ?, permissions_json = ? WHERE id = ?').run(merged.name, merged.description, merged.permissions_json, before.id);
    const role = roleView(roleRow(db, before.id));
    audit(db, { entityType: 'role', entityId: before.id, action: 'update', actor: actor.email, actorUserId: actor.id, before: roleView(before), after: role, at: now() });
    return { role, changed: true };
  });
}

/** Delete a role of the city's own — only when nobody holds it and no workflow step needs it. */
export function deleteRole(db, roleId, { actorUserId, now = defaultNow, audit = writeAudit } = {}) {
  return inTransaction(db, () => {
    const actor = requirePermission(db, actorUserId, ACCESS_ADMIN);
    const role = editableRole(db, roleId);
    const holders = db.prepare('SELECT COUNT(*) AS n FROM user_roles WHERE role_id = ?').get(role.id).n;
    if (holders) throw new ConflictError(`${holders} user(s) still hold ${role.name}. Remove it from them first.`);
    const steps = db.prepare('SELECT COUNT(*) AS n FROM workflow_steps WHERE required_role = ?').get(role.id).n;
    if (steps) throw new ConflictError(`${steps} workflow step(s) require ${role.name}, so work orders on them could never move. Publish those workflows without it first.`);
    db.prepare('DELETE FROM roles WHERE id = ?').run(role.id);
    audit(db, { entityType: 'role', entityId: role.id, action: 'delete', actor: actor.email, actorUserId: actor.id, before: roleView(role), at: now() });
    return { deleted: role.id };
  });
}
