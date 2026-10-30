// API clients (STORY-011): who may read work order data from outside, and an audit entry for
// every attempt to do so.
//
// Keys look like  hwo_<prefix>_<secret>. The prefix is stored in clear so the key can be found;
// only a sha256 hash of the whole key is stored, so a copy of the database does not leak keys.
// The key is returned once, from createApiClient, and never written anywhere else.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { inTransaction } from '../db.js';
import { writeAudit, ValidationError, ConflictError } from '../workOrders.js';

export const READ_SCOPE = 'work_orders:read';

export class UnauthorizedError extends Error {
  constructor(message = 'A valid API key is required') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

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
  return { id: row.id, name: row.name, scopes: JSON.parse(row.scopes), created_at: row.created_at, revoked_at: row.revoked_at };
}

/** The active client a key belongs to, or null. Constant-time comparison of the hash. */
export function authenticate(db, presentedKey) {
  const match = /^hwo_([0-9a-f]{8})_[A-Za-z0-9_-]+$/.exec(String(presentedKey ?? ''));
  if (!match) return null;
  const row = db.prepare('SELECT * FROM api_clients WHERE key_prefix = ?').get(match[1]);
  if (!row || row.revoked_at) return null;
  const given = Buffer.from(sha256(presentedKey), 'hex');
  const stored = Buffer.from(row.key_hash, 'hex');
  return given.length === stored.length && timingSafeEqual(given, stored) ? publicClient(row) : null;
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
  const client = authenticate(db, key);
  const at = now();

  if (!client || !client.scopes.includes(scope)) {
    const reason = client ? `missing scope ${scope}` : 'missing or invalid API key';
    try {
      audit(db, {
        entityType: 'api_access', entityId: client?.id ?? 'unknown', action: 'denied', actor: client?.name ?? 'anonymous',
        after: { operation, params, reason }, at,
      });
    } catch (err) {
      throw new AuditUnavailableError(err);
    }
    throw new UnauthorizedError(client ? `This key does not allow ${scope}` : undefined);
  }

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
