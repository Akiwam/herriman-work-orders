// Operational readiness (STORY-010, REQ-052, REQ-053): is the system ready to go live by July 1, 2027?
//
// The checklist has two kinds of items:
//   - automatic checks the system runs against itself (configuration, connections, a work order smoke
//     test);
//   - manual items that only people can confirm (data conversion rehearsed, user acceptance testing,
//     vendor testing, the city's roles confirmed). The system never decides these: a reviewer records
//     each one with a status and a note, and every change is audited.
// Items are grouped by REQ-052's three kinds of work: configuration, testing and data conversion.

import { randomUUID } from 'node:crypto';
import { inTransaction, openDatabase } from './db.js';
import {
  writeAudit, ValidationError, NotFoundError, createWorkOrder, updateWorkOrder, completeWorkOrder,
} from './workOrders.js';
import { hasPermission, AccessDeniedError, ADMIN_ROLE } from './access.js';
import { listSettings } from './settings.js';
import { validateWorkflow, getWorkflow } from './workflows.js';

export const READINESS_REVIEW = 'readiness:review';
export const TARGET_DATE = '2027-07-01'; // REQ-053: the software must be operational by July 1, 2027
export const STATUSES = ['not_started', 'in_progress', 'blocked', 'done', 'not_applicable'];
const PASSING = new Set(['done', 'not_applicable']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const defaultNow = () => new Date().toISOString();

/**
 * The manual items. Every one is required for launch: "not applicable" counts as passed, but only
 * with a note saying why, so nothing is waved through silently.
 */
export const MANUAL_ITEMS = {
  'configuration.roles_confirmed': { category: 'configuration', title: 'The city has confirmed its staff roles and what each may do (the built-in roles are placeholders)' },
  'configuration.retention_rules_confirmed': { category: 'configuration', title: 'Records retention for submitter IP addresses and the vendor review deadline are confirmed and set' },
  'configuration.production_environment': { category: 'configuration', title: 'Production database and server are set up, backed up, and a restore has been tested' },
  'testing.user_acceptance': { category: 'testing', title: 'City staff have tested creating, updating and completing work orders and signed it off (REQ-051)' },
  'testing.vendor_apis': { category: 'testing', title: 'API specifications and testing are coordinated and passed with Lama, Sprypoint and Madison AI (REQ-054)' },
  'testing.live_gis_and_bluestakes': { category: 'testing', title: 'Tested against the city\'s real GIS and the real Blue Stakes service' },
  'testing.staff_trained': { category: 'testing', title: 'Staff who will use the system are trained' },
  'data_conversion.source_identified': { category: 'data_conversion', title: 'The existing work order data and the system it comes from are identified' },
  'data_conversion.rehearsed': { category: 'data_conversion', title: 'Data conversion has been rehearsed on a copy and the record counts reconciled' },
  'data_conversion.cutover_plan': { category: 'data_conversion', title: 'The final conversion and cut-over plan is approved' },
};

function definition(key) {
  const def = Object.hasOwn(MANUAL_ITEMS, key) ? MANUAL_ITEMS[key] : null;
  if (!def) {
    const err = new NotFoundError(key);
    err.message = `No readiness item ${key}`;
    throw err;
  }
  return def;
}

function requireReviewer(db, actorUserId) {
  if (!hasPermission(db, actorUserId, READINESS_REVIEW)) throw new AccessDeniedError(READINESS_REVIEW);
  return db.prepare('SELECT id, email FROM users WHERE id = ?').get(actorUserId);
}

/** The current state of every manual item, with who recorded it and when. Unrecorded items are not_started. */
export function listManualItems(db) {
  const rows = new Map(db.prepare('SELECT * FROM readiness_items').all().map((r) => [r.item_key, r]));
  return Object.entries(MANUAL_ITEMS).map(([key, def]) => {
    const r = rows.get(key);
    return {
      key, ...def, status: r?.status ?? 'not_started', passed: PASSING.has(r?.status), note: r?.note ?? null, due_on: r?.due_on ?? null,
      version: r?.version ?? 0, updated_by: r?.updated_by ?? null, updated_at: r?.updated_at ?? null,
    };
  });
}

/**
 * Record a manual item: { status?, note?, due_on? } — fields left out stay as they were.
 * Needs readiness:review. The same values again change nothing (changed: false, no audit entry).
 * Saved together with its audit entry (reviewer, time, before and after), or not at all.
 */
export function recordItem(db, key, changes, { actorUserId, now = defaultNow, audit = writeAudit } = {}) {
  const reviewer = requireReviewer(db, actorUserId);
  definition(key);
  const problems = Object.keys(changes ?? {}).filter((f) => !['status', 'note', 'due_on'].includes(f)).map((f) => `${f} is not a readiness item field`);
  if (changes?.status !== undefined && !STATUSES.includes(changes.status)) problems.push(`status must be one of ${STATUSES.join(', ')}`);
  if (changes?.note !== undefined && changes.note !== null && (typeof changes.note !== 'string' || changes.note.length > 2000)) problems.push('note must be text of at most 2000 characters');
  if (changes?.due_on !== undefined && changes.due_on !== null && !(DATE.test(changes.due_on) && !Number.isNaN(Date.parse(changes.due_on)))) problems.push('due_on must be a date like 2027-03-31');
  if (problems.length) throw new ValidationError(problems);

  return inTransaction(db, () => {
    const before = db.prepare('SELECT * FROM readiness_items WHERE item_key = ?').get(key);
    const merged = {
      status: changes.status ?? before?.status ?? 'not_started',
      note: changes.note !== undefined ? (changes.note?.trim() || null) : (before?.note ?? null),
      due_on: changes.due_on !== undefined ? changes.due_on : (before?.due_on ?? null),
    };
    if (merged.status === 'not_applicable' && !merged.note) throw new ValidationError(['a note is required to mark an item not applicable: say why']);
    if (before && merged.status === before.status && merged.note === before.note && merged.due_on === before.due_on) {
      return { item: listManualItems(db).find((i) => i.key === key), changed: false };
    }
    const at = now();
    const version = (before?.version ?? 0) + 1;
    db.prepare(`INSERT INTO readiness_items (item_key, status, note, due_on, version, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (item_key) DO UPDATE SET status = excluded.status, note = excluded.note, due_on = excluded.due_on,
                version = excluded.version, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(key, merged.status, merged.note, merged.due_on, version, reviewer.id, at);
    audit(db, {
      entityType: 'readiness_item', entityId: key, action: 'record', actor: reviewer.email, actorUserId: reviewer.id,
      before: before ? { status: before.status, note: before.note, due_on: before.due_on, version: before.version } : { status: 'not_started' },
      after: { ...merged, version }, at,
    });
    return { item: listManualItems(db).find((i) => i.key === key), changed: true };
  });
}

// ---------- automatic checks ----------
//
// Each check reads the system as it is and returns { passed, detail }. A check that throws is
// recorded as an error and counts as failed: a readiness assessment never passes something it
// could not check.

const DAY = 24 * 60 * 60 * 1000;
export const VENDORS = ['Lama', 'Sprypoint', 'Madison AI']; // REQ-055
const LIVE_EVIDENCE_DAYS = 7; // a live connection must have succeeded this recently
const VENDOR_EVIDENCE_DAYS = 30;

const daysAgo = (at, days) => new Date(Date.parse(at) - days * DAY).toISOString();

/**
 * A connection the system runs against. `declared` is how the system was started: 'live' (the real
 * service) or 'stand_in'. Declaring 'live' is not enough on its own: the log must also show a
 * successful call recently.
 */
function connectionCheck(db, at, { name, declared, logTable }) {
  if (declared !== 'live') return { passed: false, detail: `${name} is ${declared === 'stand_in' ? 'running on a stand-in, not the real service' : 'not connected'}` };
  const ok = db.prepare(`SELECT COUNT(*) AS n FROM ${logTable} WHERE outcome = 'ok' AND finished_at >= ?`).get(daysAgo(at, LIVE_EVIDENCE_DAYS)).n;
  return ok
    ? { passed: true, detail: `${name} is live, with ${ok} successful call(s) in the last ${LIVE_EVIDENCE_DAYS} days` }
    : { passed: false, detail: `${name} is declared live but has had no successful call in the last ${LIVE_EVIDENCE_DAYS} days` };
}

/** A vendor counts as integrated once its own API connection has successfully exchanged data recently. */
function vendorCheck(db, at, vendor) {
  const clients = db.prepare('SELECT name FROM api_clients WHERE revoked_at IS NULL AND lower(name) LIKE ?').all(`${vendor.toLowerCase()}%`);
  if (!clients.length) return { passed: false, detail: `no API connection is registered for ${vendor}` };
  const names = clients.map((c) => c.name);
  const ok = db.prepare(`SELECT COUNT(*) AS n FROM api_request_log WHERE client_name IN (${names.map(() => '?').join(',')})
                         AND status BETWEEN 200 AND 299 AND received_at >= ?`).get(...names, daysAgo(at, VENDOR_EVIDENCE_DAYS)).n;
  return ok
    ? { passed: true, detail: `${vendor} exchanged data successfully ${ok} time(s) in the last ${VENDOR_EVIDENCE_DAYS} days` }
    : { passed: false, detail: `${vendor} has a connection (${names.join(', ')}) but no successful exchange in the last ${VENDOR_EVIDENCE_DAYS} days` };
}

/** Create, update and complete a work order on a throwaway database with the same code (REQ-051 guardrail). */
async function smokeTest() {
  const scratch = openDatabase(':memory:');
  try {
    const actor = 'readiness-smoke-test';
    const wo = await createWorkOrder(scratch, { title: 'Readiness smoke test', work_type: 'readiness_check', location_text: 'not a real place', created_by: actor });
    await updateWorkOrder(scratch, wo.id, { priority: 'high' }, { actor });
    const done = await completeWorkOrder(scratch, wo.id, { note: 'Smoke test: created, updated and completed', actor, actorUserId: null });
    const audited = scratch.prepare("SELECT COUNT(*) AS n FROM audit_entries WHERE entity_id = ? AND entity_type = 'work_order'").get(wo.id).n;
    const passed = done.status === 'completed' && done.priority === 'high' && audited === 3;
    return { passed, detail: passed ? 'created, updated and completed a work order, with 3 audit entries' : `unexpected result: status ${done.status}, ${audited} audit entries` };
  } finally {
    scratch.close();
  }
}

/** Every automatic check: key → { category, title, run(db, at, options) }. */
export const AUTOMATIC_CHECKS = {
  'configuration.settings_valid': {
    category: 'configuration', title: 'Every system setting holds a valid value',
    run: (db) => {
      const bad = listSettings(db).filter((s) => s.problem);
      return bad.length ? { passed: false, detail: bad.map((s) => `${s.key}: ${s.problem}`).join('; ') } : { passed: true, detail: 'all settings valid' };
    },
  },
  'configuration.administrator': {
    category: 'configuration', title: 'At least one active system administrator with a key',
    run: (db) => {
      const n = db.prepare(`SELECT COUNT(*) AS n FROM users u JOIN user_roles ur ON ur.user_id = u.id
                            WHERE ur.role_id = ? AND u.is_active = 1 AND u.key_hash IS NOT NULL`).get(ADMIN_ROLE).n;
      return n ? { passed: true, detail: `${n} active administrator(s)` } : { passed: false, detail: 'no active system administrator can sign in' };
    },
  },
  'configuration.workflows_valid': {
    category: 'configuration', title: 'Every active workflow can still be completed, and the roles its steps need exist',
    run: (db) => {
      const problems = [];
      const std = getWorkflow(db, 'wf-standard-1');
      if (!std || std.steps.map((s) => s.key).join() !== 'open,completed') problems.push('the built-in Standard workflow has been changed');
      for (const { id } of db.prepare("SELECT id FROM workflows WHERE status = 'active' AND workflow_key != 'standard'").all()) {
        const wf = getWorkflow(db, id);
        const def = { key: wf.workflow_key, name: wf.name, work_type: wf.work_type, steps: wf.steps.map((s) => ({ key: s.key, name: s.name, next: s.next, final: s.final, role: s.role })) };
        for (const p of validateWorkflow(def)) problems.push(`${wf.workflow_key}: ${p}`);
        for (const s of wf.steps) if (s.role && !db.prepare('SELECT 1 FROM roles WHERE id = ?').get(s.role)) problems.push(`${wf.workflow_key}: step ${s.key} needs role ${s.role}, which does not exist`);
      }
      return problems.length ? { passed: false, detail: problems.join('; ') } : { passed: true, detail: 'all active workflows valid' };
    },
  },
  'configuration.audit_trail_writable': {
    category: 'configuration', title: 'The audit trail can be written',
    run: (db) => {
      db.exec('BEGIN');
      try {
        writeAudit(db, { entityType: 'readiness_probe', entityId: 'probe', action: 'probe', actor: 'readiness', at: defaultNow() });
      } finally {
        db.exec('ROLLBACK'); // a probe only: nothing is kept
      }
      return { passed: true, detail: 'a test entry could be written' };
    },
  },
  'testing.work_order_smoke_test': {
    category: 'testing', title: 'A work order can be created, updated and completed (REQ-051)',
    run: () => smokeTest(),
  },
  'testing.integration_queues_clear': {
    category: 'testing', title: 'Nothing is stuck waiting to reach GIS or Blue Stakes',
    run: (db) => {
      const gis = db.prepare("SELECT COUNT(*) AS n FROM gis_sync WHERE status != 'done'").get().n;
      const bs = db.prepare("SELECT COUNT(*) AS n FROM bluestakes_outbox WHERE status != 'delivered'").get().n;
      return gis || bs
        ? { passed: false, detail: `${gis} GIS update(s) and ${bs} Blue Stakes answer(s) not yet delivered` }
        : { passed: true, detail: 'no undelivered GIS updates or Blue Stakes answers' };
    },
  },
  'configuration.gis_connection': {
    category: 'configuration', title: 'Connected to the city\'s real GIS',
    run: (db, at, { connections }) => connectionCheck(db, at, { name: 'GIS', declared: connections.gis, logTable: 'gis_log' }),
  },
  'configuration.bluestakes_connection': {
    category: 'configuration', title: 'Connected to the real Blue Stakes service',
    run: (db, at, { connections }) => connectionCheck(db, at, { name: 'Blue Stakes', declared: connections.bluestakes, logTable: 'bluestakes_log' }),
  },
  ...Object.fromEntries(VENDORS.map((v) => [`testing.vendor_${v.toLowerCase().replace(/\s+/g, '_')}`, {
    category: 'testing', title: `${v} is integrated and has exchanged data (REQ-055)`,
    run: (db, at) => vendorCheck(db, at, v),
  }])),
};

// ---------- the assessment ----------

/** The record of an assessment the system cannot store: nothing is returned without its record. */
export class AssessmentNotSavedError extends Error {
  constructor(cause) {
    super('The readiness assessment could not be recorded, so no result is given. Please run it again.', { cause });
    this.name = 'AssessmentNotSavedError';
  }
}

const assessmentView = (r) => ({
  id: r.id, request_id: r.request_id, reviewer_user_id: r.reviewer_user_id, reviewer_email: r.reviewer_email,
  started_at: r.started_at, finished_at: r.finished_at, target_date: r.target_date, days_remaining: r.days_remaining,
  verdict: r.verdict, summary: JSON.parse(r.summary_json), results: JSON.parse(r.results_json),
});

export function getAssessment(db, id) {
  const r = db.prepare('SELECT * FROM readiness_assessments WHERE id = ?').get(String(id ?? ''));
  return r ? assessmentView(r) : null;
}

export const listAssessments = (db) => db.prepare('SELECT * FROM readiness_assessments ORDER BY started_at DESC, id').all().map(assessmentView);

/**
 * Assess readiness for launch: run every automatic check, take the manual items as recorded, and
 * give the verdict — 'ready' only if every item passes and the target date has not passed.
 *
 * - Needs readiness:review. The reviewer and times are stored with the result.
 * - `connections` says how the system was started: { gis: 'live' | 'stand_in', bluestakes: … }.
 * - `requestId` (optional): the same request sent twice returns the first assessment (duplicate: true).
 * - The record and its audit entry are saved together; if they cannot be, AssessmentNotSavedError
 *   and no result — an assessment that is not on record did not happen.
 *
 * `checks` and `audit` are only replaceable so tests can prove the failure paths.
 */
export async function runAssessment(db, {
  actorUserId, requestId, connections = {}, now = defaultNow, audit = writeAudit, checks = AUTOMATIC_CHECKS,
} = {}) {
  const reviewer = requireReviewer(db, actorUserId);
  if (requestId !== undefined && (typeof requestId !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(requestId))) {
    throw new ValidationError(['request_id must be 1 to 200 visible characters']);
  }
  const existing = requestId ? db.prepare('SELECT * FROM readiness_assessments WHERE request_id = ?').get(requestId) : null;
  if (existing) return { ...assessmentView(existing), duplicate: true };

  const startedAt = now();
  const results = [];
  for (const [key, check] of Object.entries(checks)) {
    try {
      const { passed, detail } = await check.run(db, startedAt, { connections });
      results.push({ key, kind: 'automatic', category: check.category, title: check.title, status: passed ? 'passed' : 'failed', passed: Boolean(passed), detail });
    } catch (err) {
      results.push({ key, kind: 'automatic', category: check.category, title: check.title, status: 'error', passed: false, detail: `the check could not run: ${err.message}` });
    }
  }
  const today = startedAt.slice(0, 10);
  for (const item of listManualItems(db)) {
    const overdue = !item.passed && item.due_on && item.due_on < today;
    results.push({
      key: item.key, kind: 'manual', category: item.category, title: item.title, status: item.status, passed: item.passed,
      detail: [item.note, item.due_on ? `due ${item.due_on}${overdue ? ' — OVERDUE' : ''}` : 'no due date set', item.updated_at ? `recorded ${item.updated_at}` : 'never recorded'].filter(Boolean).join('; '),
      overdue: Boolean(overdue),
    });
  }

  const daysRemaining = Math.ceil((Date.parse(`${TARGET_DATE}T00:00:00Z`) - Date.parse(startedAt)) / DAY);
  if (daysRemaining < 0) results.push({ key: 'schedule.target_date', kind: 'automatic', category: 'schedule', title: `Operational by ${TARGET_DATE} (REQ-053)`, status: 'failed', passed: false, detail: `the target date passed ${-daysRemaining} day(s) ago` });
  const summary = {
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed && r.status !== 'error').length,
    errors: results.filter((r) => r.status === 'error').length,
    overdue: results.filter((r) => r.overdue).length,
    blockers: results.filter((r) => !r.passed).map((r) => r.key),
  };
  const verdict = summary.passed === summary.total ? 'ready' : 'not_ready';
  const finishedAt = now();
  const row = {
    id: randomUUID(), request_id: requestId ?? null, reviewer_user_id: reviewer.id, reviewer_email: reviewer.email,
    started_at: startedAt, finished_at: finishedAt, target_date: TARGET_DATE, days_remaining: daysRemaining, verdict,
    summary_json: JSON.stringify(summary), results_json: JSON.stringify(results),
  };

  try {
    inTransaction(db, () => {
      db.prepare(`INSERT INTO readiness_assessments (id, request_id, reviewer_user_id, reviewer_email, started_at, finished_at, target_date,
                  days_remaining, verdict, summary_json, results_json) VALUES (:id, :request_id, :reviewer_user_id, :reviewer_email, :started_at,
                  :finished_at, :target_date, :days_remaining, :verdict, :summary_json, :results_json)`).run(row);
      audit(db, {
        entityType: 'readiness_assessment', entityId: row.id, action: 'run', actor: reviewer.email, actorUserId: reviewer.id,
        after: { verdict, days_remaining: daysRemaining, summary, started_at: startedAt, finished_at: finishedAt }, at: finishedAt,
      });
    });
  } catch (err) {
    // A repeat that raced past the check above: return the first one, as a repeat should.
    const raced = requestId ? db.prepare('SELECT * FROM readiness_assessments WHERE request_id = ?').get(requestId) : null;
    if (raced) return { ...assessmentView(raced), duplicate: true };
    throw new AssessmentNotSavedError(err);
  }
  return { ...getAssessment(db, row.id), duplicate: false };
}
