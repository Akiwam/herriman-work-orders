// The integrations and operational readiness view (STORY-018, REQ-060): one place showing each external
// connection, its last successful call, and the readiness checks with the evidence behind them.
//
// Nothing here stores a status. Every status is worked out, each time it is asked for, from records of
// real calls that already exist:
//   - GIS          gis_log               every call we make to GIS, one row per attempt (STORY-002)
//   - Blue Stakes  bluestakes_log        every call we make to Blue Stakes, one row per attempt (STORY-004)
//   - vendors      vendor_exchange_log   every request a vendor makes to its feed (STORY-009, one-way)
//   - "Check now"  integration_checks    a check a person asked for here, with what the reply looked like
// So if a call fails, the very next view shows it; there is no flag that could be left behind.
//
// Readiness: the automatic checks come from the latest readiness assessment (a real run, with its time,
// STORY-010); the manual items come from what reviewers recorded. A check with nothing behind it is
// shown as "no evidence recorded", never as a pass.

import { inTransaction } from './db.js';
import { writeAudit, ValidationError, NotFoundError } from './workOrders.js';
import { hasPermission, AccessDeniedError } from './access.js';
import { VENDORS } from './vendors.js';
import { AUTOMATIC_CHECKS, READINESS_REVIEW, getAssessment, listManualItems } from './readiness.js';

const defaultNow = () => new Date().toISOString();

/**
 * Every integration the view shows. `table` and `filter` say where its calls are recorded; both are
 * fixed here, never taken from a request. `checkable`: whether "Check now" can make a safe, read-only
 * call. Blue Stakes has no read-only call (its only call sends a ticket response), and we do not call
 * vendors (they read from us), so for those the status comes from their real calls only.
 */
export const INTEGRATIONS = {
  gis: {
    vendor: 'City GIS', direction: 'outbound', purpose: 'Asset locations and details for work orders',
    table: 'gis_log', filter: null, checkable: true,
  },
  bluestakes: {
    vendor: 'Blue Stakes of Utah', direction: 'outbound', purpose: 'Responses to utility locate tickets',
    table: 'bluestakes_log', filter: null, checkable: false,
  },
  ...Object.fromEntries(Object.entries(VENDORS).map(([key, v]) => [key, {
    vendor: v.name, direction: 'inbound', purpose: v.purpose,
    table: 'vendor_exchange_log', filter: { column: 'vendor', value: key }, checkable: false,
  }])),
};

function definition(name) {
  const def = Object.hasOwn(INTEGRATIONS, name) ? INTEGRATIONS[name] : null;
  if (!def) throw Object.assign(new NotFoundError(name), { message: `No integration ${name}` });
  return def;
}

/**
 * The calls of one integration, oldest first, as { outcome, error, finished_at }.
 * A "Check now" that found a problem with the reply also left an 'ok' row in the call log (the call
 * itself answered); that row is left out, so the check's finding is what counts for that call.
 */
function events(db, name, def) {
  const where = def.filter ? `l.${def.filter.column} = :value` : '1 = 1';
  return db.prepare(`
    SELECT outcome, error, finished_at FROM (
      SELECT l.id, l.outcome, l.error, l.finished_at, 0 AS source FROM ${def.table} l
       WHERE ${where}
         AND NOT (l.outcome = 'ok' AND EXISTS (
           SELECT 1 FROM integration_checks c WHERE c.integration = :name AND c.outcome != 'ok'
              AND l.finished_at BETWEEN c.started_at AND c.finished_at))
      UNION ALL
      SELECT id, outcome, error, finished_at, 1 AS source FROM integration_checks WHERE integration = :name
    ) ORDER BY finished_at, source, id`).all({ name, ...(def.filter ? { value: def.filter.value } : {}) });
}

/**
 * The status of one integration, worked out from its calls:
 *   never_called  no call on record: no last success to show
 *   healthy       the latest call succeeded
 *   failing       the latest call failed: error_class is how it failed, failing_since is the first
 *                 failure after the last success (or the first call ever, if none has succeeded)
 */
function statusOf(name, def, calls, connections) {
  const last = calls.at(-1) ?? null;
  const lastOkIndex = calls.findLastIndex((c) => c.outcome === 'ok');
  const base = {
    name, vendor: def.vendor, direction: def.direction, purpose: def.purpose, checkable: def.checkable,
    connection: def.direction === 'inbound' ? 'one-way feed: the vendor reads from us' : (connections[name] ?? 'not declared'),
    calls_on_record: calls.length,
    last_call_at: last?.finished_at ?? null,
    last_success_at: lastOkIndex >= 0 ? calls[lastOkIndex].finished_at : null,
    error_class: null, error: null, failing_since: null,
  };
  if (!last) return { ...base, status: 'never_called' };
  if (last.outcome === 'ok') return { ...base, status: 'healthy' };
  return { ...base, status: 'failing', error_class: last.outcome, error: last.error, failing_since: calls[lastOkIndex + 1].finished_at };
}

/**
 * Every integration's status, worked out now from the call records.
 * `connections` is how the system was started, as in the readiness assessment: { gis: 'live' | 'stand_in', … }.
 */
export function integrationStatus(db, { connections = {}, now = defaultNow } = {}) {
  return {
    generated_at: now(),
    items: Object.entries(INTEGRATIONS).map(([name, def]) => statusOf(name, def, events(db, name, def), connections)),
  };
}

/** What a GIS changes reply must look like: { changes: [{ seq: integer, asset_id: text, … }] }. */
export function gisChangesProblem(reply) {
  if (!reply || typeof reply !== 'object' || !Array.isArray(reply.changes)) return 'the reply has no list of changes';
  const bad = reply.changes.findIndex((c) => !c || !Number.isInteger(c.seq) || typeof c.asset_id !== 'string');
  return bad >= 0 ? `change ${bad + 1} has no whole-number seq or no asset_id` : null;
}

const CURSOR_SQL = 'SELECT value FROM gis_cursor ORDER BY updated_at DESC LIMIT 1';

/**
 * "Check now": make one real, read-only call to an integration and record what came back.
 *
 * - Needs readiness:review (project manager or administrator). The person and time are recorded.
 * - GIS: asks for the asset changes after the current sync position. It only reads; the position does
 *   not move, so checking twice changes nothing except adding a second check to the record.
 * - The call goes through the GIS client, so it has the same timeout and capped retries as every
 *   other GIS call, and every attempt is in gis_log too.
 * - A reply that arrives but has the wrong shape is recorded as unexpected_payload: a failure.
 * - The check and its audit entry are saved together. If they cannot be saved, the error is thrown and
 *   no result is returned: a check that is not on record did not happen.
 */
export async function checkIntegration(db, name, { gis = null, actorUserId, now = defaultNow, audit = writeAudit } = {}) {
  if (!hasPermission(db, actorUserId, READINESS_REVIEW)) throw new AccessDeniedError(READINESS_REVIEW);
  const def = definition(name);
  if (!def.checkable) {
    throw new ValidationError([`${def.vendor} has no read-only call to check with; its status comes from its real calls`]);
  }
  if (!gis) throw new ValidationError(['GIS is not connected in this system, so there is nothing to call']);
  const person = db.prepare('SELECT id, email FROM users WHERE id = ?').get(actorUserId);

  const startedAt = now();
  let outcome = 'ok';
  let error = null;
  try {
    const cursor = db.prepare(CURSOR_SQL).get()?.value ?? 0;
    const problem = gisChangesProblem(await gis.getChangesSince(cursor));
    if (problem) [outcome, error] = ['unexpected_payload', `GIS answered, but ${problem}`];
  } catch (err) {
    outcome = ['timeout', 'unauthorized'].includes(err?.code) ? err.code : 'error';
    error = String(err?.message ?? err).slice(0, 1000);
  }
  const finishedAt = now();

  const check = {
    integration: name, requested_by: person.id, outcome, error,
    started_at: startedAt, finished_at: finishedAt, duration_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
  };
  inTransaction(db, () => {
    db.prepare(`INSERT INTO integration_checks (integration, requested_by, outcome, error, started_at, finished_at, duration_ms)
                VALUES (:integration, :requested_by, :outcome, :error, :started_at, :finished_at, :duration_ms)`).run(check);
    audit(db, {
      entityType: 'integration_check', entityId: name, action: 'check', actor: person.email, actorUserId: person.id,
      after: { outcome, error }, at: finishedAt,
    });
  });
  return { check, status: integrationStatus(db, { now }).items.find((i) => i.name === name) };
}

// ---------- readiness ----------

const NO_EVIDENCE = 'no evidence recorded';

/**
 * The readiness checks, each with pass or fail and the evidence behind it.
 *   - Automatic checks: from the latest assessment (when it ran, who ran it, what each check found).
 *     None run yet → every automatic check is shown as not run, with no evidence.
 *   - Manual items: as reviewers recorded them. An item marked done (or not applicable) with no note
 *     saying what shows it is shown as no_evidence and does not count as passed here.
 */
export function readinessView(db) {
  const latestId = db.prepare('SELECT id FROM readiness_assessments ORDER BY started_at DESC, id LIMIT 1').get()?.id;
  const assessment = latestId ? getAssessment(db, latestId) : null;

  const automatic = assessment
    ? assessment.results.filter((r) => r.kind === 'automatic').map((r) => {
      const evidence = r.detail?.trim() || null;
      return {
        key: r.key, kind: 'automatic', category: r.category, title: r.title,
        result: !evidence ? 'no_evidence' : r.passed ? 'pass' : 'fail',
        passed: Boolean(r.passed && evidence), evidence: evidence ?? NO_EVIDENCE, checked_at: assessment.finished_at,
      };
    })
    : Object.entries(AUTOMATIC_CHECKS).map(([key, c]) => ({
      key, kind: 'automatic', category: c.category, title: c.title, result: 'not_run', passed: false, evidence: 'never run: no assessment yet', checked_at: null,
    }));

  const manual = listManualItems(db).map((i) => {
    const evidence = i.note?.trim() || null;
    let result = 'fail';
    if (i.passed) result = evidence ? 'pass' : 'no_evidence';
    return {
      key: i.key, kind: 'manual', category: i.category, title: i.title, recorded_status: i.status,
      result, passed: result === 'pass',
      evidence: evidence ?? NO_EVIDENCE, recorded_by: i.updated_by, checked_at: i.updated_at,
    };
  });

  const checks = [...automatic, ...manual];
  return {
    assessment: assessment && {
      id: assessment.id, started_at: assessment.started_at, finished_at: assessment.finished_at,
      reviewer_email: assessment.reviewer_email, verdict: assessment.verdict, days_remaining: assessment.days_remaining,
    },
    summary: {
      total: checks.length,
      passed: checks.filter((c) => c.result === 'pass').length,
      failed: checks.filter((c) => c.result === 'fail').length,
      no_evidence: checks.filter((c) => c.result === 'no_evidence').length,
      not_run: checks.filter((c) => c.result === 'not_run').length,
    },
    checks,
  };
}
