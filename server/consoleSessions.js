// Console sign-in sessions (STORY-014).
//
// A person signs in to the console with their personal key (STORY-007). They get back a session
// token, hws_<prefix>_<secret>, which the console uses for every request instead of the key, so the
// key itself never sits in the browser. Like keys, only a sha256 hash of the token is stored.
//
// A session ends:
//   - after 30 minutes without a request (idle), or 8 hours after sign-in, whichever comes first;
//   - on sign-out;
//   - at once if the person is deactivated (their session no longer finds an active user).
// An ended session simply stops working: the next request gets 401, and the console asks the person
// to sign in again. Their permissions are still re-read from their roles on every request.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { userForKey } from './access.js';
import { writeAudit, ValidationError } from './workOrders.js';
import { inTransaction } from './db.js';

export const IDLE_MINUTES = 30;
export const MAX_HOURS = 8;
const TOKEN = /^hws_([0-9a-f]{8})_[A-Za-z0-9_-]+$/;
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const defaultNow = () => new Date().toISOString();

export const looksLikeSessionToken = (token) => String(token ?? '').startsWith('hws_');

/**
 * Sign in with a personal key. Returns { token, expires_at, user } — the token is in this return
 * value only. A wrong or deactivated key gives null (the caller audits and refuses it).
 */
export function startSession(db, personalKey, { now = defaultNow, audit = writeAudit } = {}) {
  const user = userForKey(db, personalKey);
  if (!user) return null;
  const at = now();
  const prefix = randomBytes(4).toString('hex');
  const token = `hws_${prefix}_${randomBytes(24).toString('base64url')}`;
  const expiresAt = new Date(Date.parse(at) + MAX_HOURS * 60 * 60 * 1000).toISOString();
  const id = randomUUID();
  inTransaction(db, () => {
    db.prepare(`INSERT INTO console_sessions (id, token_prefix, token_hash, user_id, created_at, last_seen_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, prefix, sha256(token), user.id, at, at, expiresAt);
    audit(db, { entityType: 'console_session', entityId: id, action: 'sign_in', actor: user.email, actorUserId: user.id, after: { expires_at: expiresAt }, at });
  });
  return { token, expires_at: expiresAt, user: { id: user.id, email: user.email, display_name: user.display_name } };
}

/**
 * The active user a session token belongs to, or null if the token is wrong, signed out, idle too
 * long, past its 8 hours, or the person was deactivated. A valid use counts as activity.
 */
export function userForSession(db, token, { now = defaultNow } = {}) {
  const match = TOKEN.exec(String(token ?? ''));
  if (!match) return null;
  const row = db.prepare(`SELECT s.*, u.email, u.display_name, u.is_active FROM console_sessions s JOIN users u ON u.id = s.user_id
                          WHERE s.token_prefix = ?`).get(match[1]);
  if (!row || row.ended_at || row.is_active !== 1) return null;
  const given = Buffer.from(sha256(token), 'hex');
  if (!timingSafeEqual(given, Buffer.from(row.token_hash, 'hex'))) return null;
  const at = now();
  const idleSince = Date.parse(at) - Date.parse(row.last_seen_at);
  if (Date.parse(at) >= Date.parse(row.expires_at) || idleSince >= IDLE_MINUTES * 60 * 1000) return null;
  db.prepare('UPDATE console_sessions SET last_seen_at = ? WHERE id = ?').run(at, row.id);
  return { id: row.user_id, email: row.email, display_name: row.display_name, session_id: row.id };
}

/** Sign out. Safe to repeat: signing out an ended or unknown session changes nothing. */
export function endSession(db, token, { now = defaultNow, audit = writeAudit } = {}) {
  const match = TOKEN.exec(String(token ?? ''));
  if (!match) throw new ValidationError(['not a session token']);
  const row = db.prepare('SELECT s.*, u.email FROM console_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_prefix = ?').get(match[1]);
  if (!row || row.ended_at || !timingSafeEqual(Buffer.from(sha256(token), 'hex'), Buffer.from(row.token_hash, 'hex'))) return { ended: false };
  const at = now();
  inTransaction(db, () => {
    db.prepare('UPDATE console_sessions SET ended_at = ? WHERE id = ?').run(at, row.id);
    audit(db, { entityType: 'console_session', entityId: row.id, action: 'sign_out', actor: row.email, actorUserId: row.user_id, at });
  });
  return { ended: true };
}
