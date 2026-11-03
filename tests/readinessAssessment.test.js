// STORY-010 — the readiness assessment: an honest verdict, with every blocker named, kept on record.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../server/db.js';
import { bootstrapAdministrator, issueUserKey, createUser, grantRole, AccessDeniedError } from '../server/access.js';
import { createApiClient } from '../server/api/clients.js';
import { publishWorkflow } from '../server/workflows.js';
import { createWorkOrder } from '../server/workOrders.js';
import {
  runAssessment, recordItem, listAssessments, MANUAL_ITEMS, AUTOMATIC_CHECKS, AssessmentNotSavedError,
} from '../server/readiness.js';

const NOW = '2026-11-02T09:00:00.000Z';
const now = () => NOW;

function setup() {
  const db = openDatabase();
  const admin = bootstrapAdministrator(db, { email: 'jane.admin@herriman.example', display_name: 'Jane Admin' });
  issueUserKey(db, admin.id, { actorUserId: admin.id });
  const pat = createUser(db, { email: 'pat.pm@herriman.example', display_name: 'Pat Project-Manager' }, { actorUserId: admin.id });
  grantRole(db, { userId: pat.id, roleId: 'project_manager' }, { actorUserId: admin.id });
  return { db, admin, pat, byPat: { actorUserId: pat.id, now } };
}

/** Make everything genuinely ready: real connections with recent successful calls, vendors exchanging data, every manual item done. */
function makeReady(db, byPat) {
  db.prepare("INSERT INTO gis_log (operation, attempt, outcome, started_at, finished_at, duration_ms) VALUES ('getAsset', 1, 'ok', ?, ?, 40)").run(NOW, NOW);
  db.prepare("INSERT INTO bluestakes_log (operation, attempt, outcome, started_at, finished_at, duration_ms) VALUES ('sendResponse', 1, 'ok', ?, ?, 40)").run(NOW, NOW);
  for (const vendor of ['Lama', 'Sprypoint', 'Madison AI']) {
    createApiClient(db, { name: vendor, actor: 'admin-1' });
    db.prepare(`INSERT INTO api_request_log (request_id, received_at, finished_at, duration_ms, method, path, client_name, status)
                VALUES (?, ?, ?, 12, 'GET', '/api/v1/work-orders', ?, 200)`).run(`req-${vendor}`, NOW, NOW, vendor);
  }
  for (const key of Object.keys(MANUAL_ITEMS)) recordItem(db, key, { status: 'done', note: 'Signed off at the go-live review' }, byPat);
  return { gis: 'live', bluestakes: 'live' };
}
const result = (a, key) => a.results.find((r) => r.key === key);

// ---------- AC2 + failure path "readiness criteria not met" ----------

test('today\'s system is honestly not ready, and every blocker is named', async () => {
  const { db, byPat } = setup();
  const a = await runAssessment(db, { ...byPat, connections: { gis: 'stand_in', bluestakes: 'stand_in' } });
  assert.equal(a.verdict, 'not_ready');
  for (const key of ['configuration.gis_connection', 'configuration.bluestakes_connection', 'testing.vendor_lama', 'testing.vendor_sprypoint', 'testing.vendor_madison_ai', ...Object.keys(MANUAL_ITEMS)]) {
    assert.ok(a.summary.blockers.includes(key), `${key} is a blocker`);
  }
  assert.match(result(a, 'configuration.gis_connection').detail, /stand-in/);
  assert.match(result(a, 'testing.vendor_lama').detail, /no API connection is registered for Lama/);
  for (const key of ['configuration.settings_valid', 'configuration.administrator', 'configuration.workflows_valid', 'configuration.audit_trail_writable', 'testing.work_order_smoke_test', 'testing.integration_queues_clear']) {
    assert.equal(result(a, key).passed, true, `${key} passes today`);
  }
  assert.equal(a.days_remaining, 241, 'days from 2 Nov 2026 to 1 Jul 2027');
  assert.equal(a.target_date, '2027-07-01');
});

test('when every item on the checklist is complete, the system is ready for launch', async () => {
  const { db, byPat } = setup();
  const connections = makeReady(db, byPat);
  const a = await runAssessment(db, { ...byPat, connections });
  assert.deepEqual(a.summary.blockers, []);
  assert.equal(a.verdict, 'ready');
  assert.equal(a.summary.passed, a.summary.total);
  assert.equal(a.summary.total, Object.keys(AUTOMATIC_CHECKS).length + Object.keys(MANUAL_ITEMS).length);
});

test('a connection declared live without a recent successful call does not pass', async () => {
  const { db, byPat } = setup();
  const a = await runAssessment(db, { ...byPat, connections: { gis: 'live', bluestakes: 'live' } });
  assert.match(result(a, 'configuration.gis_connection').detail, /declared live but has had no successful call/);
  assert.equal(result(a, 'configuration.bluestakes_connection').passed, false);
});

// ---------- AC1 + failure path "configuration errors" ----------

test('configuration errors are caught: a damaged setting, a broken workflow, no administrator who can sign in', async () => {
  const { db, admin, byPat } = setup();
  const connections = makeReady(db, byPat);
  db.prepare("INSERT INTO system_settings (key, value_json, version, updated_by, updated_at) VALUES ('public.rate_limit_per_hour', '{oops', 1, 'x', ?)").run(NOW);
  const wf = publishWorkflow(db, {
    key: 'pothole_repair', name: 'Pothole repair', work_type: 'pothole',
    steps: [{ key: 'received', name: 'Received', next: ['repaired'] }, { key: 'repaired', name: 'Repaired', next: ['completed'] }, { key: 'completed', name: 'Completed', next: [], final: true }],
  }, { actor: 'jane' });
  db.prepare("UPDATE workflow_steps SET next_steps_json = '[]' WHERE workflow_id = ? AND step_key = 'repaired'").run(wf.id); // damaged behind the system's back
  db.prepare('UPDATE users SET key_hash = NULL, key_prefix = NULL WHERE id = ?').run(admin.id);

  const a = await runAssessment(db, { ...byPat, connections });
  assert.equal(a.verdict, 'not_ready');
  assert.match(result(a, 'configuration.settings_valid').detail, /public.rate_limit_per_hour: stored value cannot be read/);
  assert.match(result(a, 'configuration.workflows_valid').detail, /pothole_repair: step repaired: is a dead end/);
  assert.match(result(a, 'configuration.administrator').detail, /no active system administrator can sign in/);
});

test('work stuck on its way to GIS or Blue Stakes is a blocker', async () => {
  const { db, byPat } = setup();
  const connections = makeReady(db, byPat);
  const wo = await createWorkOrder(db, { title: 'Streetlight out', work_type: 'streetlight', location_text: 'Stand-in', created_by: 'test' });
  db.prepare("INSERT INTO gis_sync (work_order_id, asset_id, status, requested_at) VALUES (?, 'SL-0001', 'failed', ?)").run(wo.id, NOW); // GIS was down
  const a = await runAssessment(db, { ...byPat, connections });
  assert.match(result(a, 'testing.integration_queues_clear').detail, /1 GIS update/);
  assert.equal(a.verdict, 'not_ready');
});

test('a check that crashes counts as failed, and the rest still run', async () => {
  const { db, byPat } = setup();
  const checks = { ...AUTOMATIC_CHECKS, 'configuration.settings_valid': { ...AUTOMATIC_CHECKS['configuration.settings_valid'], run: () => { throw new Error('settings store unreachable'); } } };
  const connections = makeReady(db, byPat);
  const a = await runAssessment(db, { ...byPat, connections, checks });
  const crashed = result(a, 'configuration.settings_valid');
  assert.deepEqual([crashed.status, crashed.passed], ['error', false]);
  assert.match(crashed.detail, /could not run: settings store unreachable/);
  assert.equal(a.summary.errors, 1);
  assert.equal(a.verdict, 'not_ready');
  assert.equal(result(a, 'testing.work_order_smoke_test').passed, true);
});

test('overdue manual items are flagged, and a passed target date is itself a blocker', async () => {
  const { db, byPat } = setup();
  recordItem(db, 'data_conversion.rehearsed', { status: 'in_progress', due_on: '2026-10-31' }, byPat);
  const a = await runAssessment(db, byPat);
  assert.equal(result(a, 'data_conversion.rehearsed').overdue, true);
  assert.match(result(a, 'data_conversion.rehearsed').detail, /due 2026-10-31 — OVERDUE/);
  assert.equal(a.summary.overdue, 1);

  const late = await runAssessment(db, { ...byPat, now: () => '2027-07-05T09:00:00.000Z' });
  assert.match(result(late, 'schedule.target_date').detail, /passed 4 day/);
});

// ---------- Trust: every assessment is on record with timestamps and the reviewer ----------

test('every assessment is kept with the reviewer and times, and audited', async () => {
  const { db, pat, byPat } = setup();
  const a = await runAssessment(db, byPat);
  const [stored] = listAssessments(db);
  assert.deepEqual([stored.id, stored.reviewer_user_id, stored.reviewer_email, stored.started_at, stored.finished_at],
    [a.id, pat.id, 'pat.pm@herriman.example', NOW, NOW]);
  assert.equal(stored.results.length, a.results.length);
  const entry = db.prepare("SELECT * FROM audit_entries WHERE entity_type = 'readiness_assessment'").get();
  assert.deepEqual([entry.entity_id, entry.action, entry.actor_user_id, entry.occurred_at], [a.id, 'run', pat.id, NOW]);
  assert.equal(JSON.parse(entry.after_json).verdict, 'not_ready');
});

test('the same request sent twice gives one assessment', async () => {
  const { db, byPat } = setup();
  const first = await runAssessment(db, { ...byPat, requestId: 'go-live-review-1' });
  const again = await runAssessment(db, { ...byPat, requestId: 'go-live-review-1' });
  assert.equal(again.duplicate, true);
  assert.equal(again.id, first.id);
  assert.equal(listAssessments(db).length, 1);
  assert.equal((await runAssessment(db, byPat)).duplicate, false, 'a new review without the id is a new assessment');
});

test('if the assessment cannot be recorded, no result is given', async () => {
  const { db, byPat } = setup();
  await assert.rejects(runAssessment(db, { ...byPat, audit: () => { throw new Error('audit store unavailable'); } }), AssessmentNotSavedError);
  assert.equal(listAssessments(db).length, 0);
});

// ---------- failure path: unauthorized access ----------

test('only people with readiness:review can run an assessment', async () => {
  const { db, admin } = setup();
  const sam = createUser(db, { email: 'sam@herriman.example', display_name: 'Sam Crew' }, { actorUserId: admin.id });
  grantRole(db, { userId: sam.id, roleId: 'field_crew' }, { actorUserId: admin.id });
  await assert.rejects(runAssessment(db, { actorUserId: sam.id }), AccessDeniedError);
  await assert.rejects(runAssessment(db, {}), AccessDeniedError);
  assert.equal(listAssessments(db).length, 0);
});
