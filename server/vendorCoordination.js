// Vendor coordination tracker (STORY-009, REQ-054): where each vendor is on the way to an agreed,
// tested integration. People record each step; the system only stores it. Every change is audited.
//
// The steps, in order:
//   contract_shared   the city sent the vendor its published contract
//   fields_confirmed  the vendor confirmed the fields it needs (a proposed contract becomes agreed)
//   sandbox_tested    the vendor ran the conformance check (npm run vendor:check) and it passed
//   signed_off        the city and the vendor signed the integration off
// A step can only be marked done once every step before it is done, so nothing is signed off untested.

import { inTransaction } from './db.js';
import { writeAudit, ValidationError } from './workOrders.js';
import { hasPermission, AccessDeniedError } from './access.js';
import { getVendor, VENDORS } from './vendors.js';

export const STEPS = ['contract_shared', 'fields_confirmed', 'sandbox_tested', 'signed_off'];
const REVIEW = 'readiness:review';
const defaultNow = () => new Date().toISOString();

function stepRows(db, vendorKey) {
  return new Map(db.prepare('SELECT * FROM vendor_coordination WHERE vendor = ?').all(vendorKey).map((r) => [r.step, r]));
}

/** Every step for one vendor, as recorded. */
export function getCoordination(db, vendorKey) {
  const vendor = getVendor(vendorKey);
  const rows = stepRows(db, vendorKey);
  const steps = STEPS.map((step) => {
    const r = rows.get(step);
    return { step, done: r?.done === 1, note: r?.note ?? null, version: r?.version ?? 0, updated_by: r?.updated_by ?? null, updated_at: r?.updated_at ?? null };
  });
  return { vendor: vendorKey, name: vendor.name, signed_off: steps.every((s) => s.done), steps };
}

export const listCoordination = (db) => Object.keys(VENDORS).map((k) => getCoordination(db, k));

/**
 * Mark one step done or not done: { done, note }. Needs readiness:review. The same values again
 * change nothing. Undoing a step is allowed (with a note), but not while a later step is still done.
 */
export function recordStep(db, vendorKey, step, change, { actorUserId, now = defaultNow, audit = writeAudit } = {}) {
  if (!hasPermission(db, actorUserId, REVIEW)) throw new AccessDeniedError(REVIEW);
  getVendor(vendorKey);
  const problems = [];
  if (!STEPS.includes(step)) problems.push(`step must be one of ${STEPS.join(', ')}`);
  for (const f of Object.keys(change ?? {})) if (!['done', 'note'].includes(f)) problems.push(`${f} is not a step field`);
  if (typeof change?.done !== 'boolean') problems.push('done must be true or false');
  if (change?.note !== undefined && change.note !== null && (typeof change.note !== 'string' || change.note.length > 2000)) problems.push('note must be text of at most 2000 characters');
  if (problems.length) throw new ValidationError(problems);
  const note = change.note?.trim() || null;
  if (!note) throw new ValidationError(['a note is required: say what was done, or why it is undone']);

  return inTransaction(db, () => {
    const rows = stepRows(db, vendorKey);
    const index = STEPS.indexOf(step);
    if (change.done) {
      const missing = STEPS.slice(0, index).filter((s) => rows.get(s)?.done !== 1);
      if (missing.length) throw new ValidationError([`${step} cannot be done before ${missing.join(', ')}`]);
    } else {
      const later = STEPS.slice(index + 1).filter((s) => rows.get(s)?.done === 1);
      if (later.length) throw new ValidationError([`${step} cannot be undone while ${later.join(', ')} is done`]);
    }
    const before = rows.get(step);
    if (before && (before.done === 1) === change.done && before.note === note) return { coordination: getCoordination(db, vendorKey), changed: false };

    const actor = db.prepare('SELECT id, email FROM users WHERE id = ?').get(actorUserId);
    const at = now();
    const version = (before?.version ?? 0) + 1;
    db.prepare(`INSERT INTO vendor_coordination (vendor, step, done, note, version, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (vendor, step) DO UPDATE SET done = excluded.done, note = excluded.note, version = excluded.version,
                updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(vendorKey, step, change.done ? 1 : 0, note, version, actor.id, at);
    audit(db, {
      entityType: 'vendor_coordination', entityId: `${vendorKey}:${step}`, action: 'record', actor: actor.email, actorUserId: actor.id,
      before: before ? { done: before.done === 1, note: before.note, version: before.version } : { done: false },
      after: { done: change.done, note, version }, at,
    });
    return { coordination: getCoordination(db, vendorKey), changed: true };
  });
}
