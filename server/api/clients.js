// API clients (STORY-011): who may read work order data from outside, and an audit entry for
// every attempt to do so.
//
// Keys look like  hwo_<prefix>_<secret>. The prefix is stored in clear so the key can be found;
// only a sha256 hash of the whole key is stored, so a copy of the database does not leak keys.
// The key is returned once, from createApiClient, and never written anywhere else.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { inTransaction } from '../db.js';
import { writeAudit, ValidationError, ConflictError } from '../workOrders.js';
import { userForKey, looksLikeUserKey, permissionsFor } from '../access.js';
import { setActingUser } from '../requestContext.js';

export const READ_SCOPE = 'work_orders:read';

export class UnauthorizedError extends Error {
  constructor(message = 'A valid API key is required') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/** A valid key that lacks the permission for this request (HTTP 403). Still an UnauthorizedError. */
export class ForbiddenError extends UnauthorizedError {
  constructor(scope) {
    super(`This key does not allow ${scope}`);
    this.name = 'ForbiddenError';
    this.scope = scope;
  }
}

export const LOCATE_TICKETS_SCOPE = 'locate_tickets:write';
export const WORK_ORDERS_WRITE_SCOPE = 'work_orders:write';
export const VENDOR_SUBMIT_SCOPE = 'vendor:submit'; // a vendor answering the requirements (STORY-012)
export const VENDOR_REVIEW_SCOPE = 'vendor:review'; // a city reviewer of vendor submissions
export const HEATMAPS_SCOPE = 'heatmaps:read'; // planners and staff viewing heat maps (STORY-005)
export const WORKFLOWS_ADMIN_SCOPE = 'workflows:admin'; // administrators publishing and retiring workflows (STORY-006)

/** The access could not be recorded, so it is refused: no data leaves without an audit entry. */
export class AuditUnavailableError extends Error {
  constructor(cause) {
    super('Access refused: the audit trail could not be written', { cause });
    this.name = 'AuditUnavailableError';
  }
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const defaultNow = () => new Date().toISOString();

/**
 * Register an outside system and issue its key. The key is in the return value only — show it
 * to the administrator once; it cannot be recovered later. Registering the same name twice is
 * refused rather than silently issuing a second key.
 */
export function createApiClient(db, { name, scopes = [READ_SCOPE], actor }, { now = defaultNow } = {}) {
  const problems = [];
  if (typeof name !== 'string' || !name.trim()) problems.push('name is required');
  if (typeof actor !== 'string' || !actor.trim()) problems.push('actor is required');
  if (problems.length) throw new ValidationError(problems);
  if (db.prepare('SELECT 1 FROM api_clients WHERE name = ?').get(name.trim())) {
    throw new ConflictError(`An API client named "${name.trim()}" already exists`);
  }

  const prefix = randomBytes(4).toString('hex');
  const key = `hwo_${prefix}_${randomBytes(24).toString('base64url')}`;
  const at = now();
  const client = {
    id: randomUUID(),
    name: name.trim(),
    key_prefix: prefix,
    key_hash: sha256(key),
    scopes: JSON.stringify(scopes),
    created_by: actor.trim(),
    created_at: at,
    revoked_at: null,
  };
  inTransaction(db, () => {
    db.prepare(`INSERT INTO api_clients (id, name, key_prefix, key_hash, scopes, created_by, created_at, revoked_at)
                VALUES (:id, :name, :key_prefix, :key_hash, :scopes, :created_by, :created_at, :revoked_at)`).run(client);
    const { key_hash: _hash, ...safe } = client; // never put the hash or key in the audit trail
    writeAudit(db, { entityType: 'api_client', entityId: client.id, action: 'create', actor: client.created_by, after: safe, at });
  });
  return { client: publicClient(client), key };
}

/** Stop a client's key from working. Audited. */
export function revokeApiClient(db, id, { actor }, { now = defaultNow } = {}) {
  if (typeof actor !== 'string' || !actor.trim()) throw new ValidationError(['actor is required']);
  inTransaction(db, () => {
    const row = db.prepare('SELECT * FROM api_clients WHERE id = ?').get(id);
    if (!row) throw new ValidationError([`no API client ${id}`]);
    if (row.revoked_at) return;
    const at = now();
    db.prepare('UPDATE api_clients SET revoked_at = ? WHERE id = ?').run(at, id);
    writeAudit(db, { entityType: 'api_client', entityId: id, action: 'revoke', actor: actor.trim(), at });
  });
}

function publicClient(row) {
  return { kind: 'system', id: row.id, name: row.name, scopes: JSON.parse(row.scopes), created_at: row.created_at, revoked_at: row.revoked_at };
}

/**
 * Who a key belongs to, or null. Two kinds (STORY-007):
 *   - an outside system's key (hwo_…): its scopes were fixed when the key was issued;
 *   - a person's key (hwu_…): their permissions come from the roles they hold right now, so
 *     granting or removing a role changes what the key can do on the very next request. If the
 *     roles cannot be read, the key can do nothing (permissionsFor fails closed).
 * Both are returned in the same shape ({ id, name, scopes }), so every endpoint checks access the same way.
 */
export function authenticate(db, presentedKey) {
  if (looksLikeUserKey(presentedKey)) {
    const user = userForKey(db, presentedKey);
    if (!user) return null;
    return { kind: 'user', id: user.id, user_id: user.id, name: user.email, email: user.email, scopes: [...permissionsFor(db, user.id)] };
  }
  const match = /^hwo_([0-9a-f]{8})_[A-Za-z0-9_-]+$/.exec(String(presentedKey ?? ''));
  if (!match) return null;
  const row = db.prepare('SELECT * FROM api_clients WHERE key_prefix = ?').get(match[1]);
  if (!row || row.revoked_at) return null;
  const given = Buffer.from(sha256(presentedKey), 'hex');
  const stored = Buffer.from(row.key_hash, 'hex');
  return given.length === stored.length && timingSafeEqual(given, stored) ? publicClient(row) : null;
}

/**
 * The client a request comes from, if its key is valid and has `scope`. Otherwise the refusal is
 * audited ('denied', without the key) and UnauthorizedError (no/invalid key) or ForbiddenError
 * (valid key, missing scope) is thrown. If even the refusal cannot be audited, AuditUnavailableError.
 */
export function requireAccess(db, { key, operation, params = {}, scope }, { at = defaultNow(), audit = writeAudit } = {}) {
  const client = authenticate(db, key);
  if (client && client.scopes.includes(scope)) {
    if (client.kind === 'user') setActingUser(client.user_id); // every audit entry in this request gets the verified user id
    return client;
  }

  const reason = client ? `missing scope ${scope}` : 'missing or invalid API key';
  try {
    audit(db, {
      entityType: 'api_access', entityId: client?.id ?? 'unknown', action: 'denied', actor: client?.name ?? 'anonymous', actorUserId: client?.user_id ?? null,
      after: { operation, params, reason }, at,
    });
  } catch (err) {
    throw new AuditUnavailableError(err);
  }
  throw client ? new ForbiddenError(scope) : new UnauthorizedError();
}

/**
 * Run a read on behalf of an API client, with an audit entry for it.
 *
 * - No valid key, or missing scope: the refusal is audited and UnauthorizedError is thrown.
 * - Valid key: the read and its audit entry run in one transaction. If the audit entry cannot be
 *   written, AuditUnavailableError is thrown and the data is NOT returned (fail closed).
 *
 * The audit entry records who, which operation, the parameters and how many records were returned —
 * never the key. `audit` is only replaceable so tests can prove the fail-closed behaviour.
 */
export function auditedRead(db, { key, operation, params = {}, scope = READ_SCOPE }, read, { now = defaultNow, audit = writeAudit } = {}) {
  const at = now();
  const client = requireAccess(db, { key, operation, params, scope }, { at, audit });

  return inTransaction(db, () => {
    const result = read(); // a failing read throws as itself
    const count = Array.isArray(result?.items) ? result.items.length : (result ? 1 : 0);
    try {
      audit(db, {
        entityType: 'api_access', entityId: client.id, action: 'read', actor: client.name,
        after: { operation, params, records_returned: count }, at,
      });
    } catch (err) {
      throw new AuditUnavailableError(err); // the data is not returned
    }
    return result;
  });
}

/**
 * The actor text for the audit trail.
 *   - A person's key: it is them. They need not send an actor; if they do, it must be themselves,
 *     so nobody can record an action under someone else's name.
 *   - An outside system's key: the person or process it says is acting, plus the system,
 *     e.g. "sam via Crew app" — the system vouches for that name.
 */
export function actorFor(body, client, db = null, { at = defaultNow(), audit = writeAudit } = {}) {
  if (client.kind === 'user') {
    if (body.actor !== undefined && (typeof body.actor !== 'string' || body.actor.trim().toLowerCase() !== client.email)) {
      // Trying to record an action under someone else's name is a refused access attempt: audit it like one.
      if (db) {
        try {
          audit(db, {
            entityType: 'api_access', entityId: client.id, action: 'denied', actor: client.name, actorUserId: client.user_id,
            after: { reason: 'actor is not the signed-in user', claimed_actor: String(body.actor).slice(0, 200) }, at,
          });
        } catch (err) {
          throw new AuditUnavailableError(err);
        }
      }
      throw new ValidationError([`actor must be you (${client.email}) or left out: your key already says who you are`]);
    }
    return client.email;
  }
  if (typeof body.actor !== 'string' || !body.actor.trim()) throw new ValidationError(['actor is required']);
  return `${body.actor.trim()} via ${client.name}`;
}
