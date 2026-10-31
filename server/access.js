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
  const u = db.prepare('SELECT id, email, display_name, is_active, created_by, created_at FROM users WHERE id = ?').get(String(id ?? ''));
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
