// STORY-018 — the integrations and operational readiness view. Every status must come from a real call
// result, so these tests put call results in the same logs the real clients write, and check the view.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../server/db.js';
import { bootstrapAdministrator, createUser, grantRole, issueUserKey, AccessDeniedError } from '../server/access.js';
import { ValidationError } from '../server/workOrders.js';
import { createGisClient, createGisLogger, createStandInGis, loadStandInAssets, GisError } from '../server/gis.js';
import { createBlueStakesLogger } from '../server/bluestakes.js';
import { logExchange } from '../server/vendors.js';
import { runAssessment, recordItem } from '../server/readiness.js';
import { integrationStatus, checkIntegration, readinessView, gisChangesProblem, INTEGRATIONS } from '../server/integrationStatus.js';

function setup() {
  const db = openDatabase();
  const admin = bootstrapAdministrator(db, { email: 'jane.admin@herriman.example', display_name: 'Jane Admin' });
  const sam = createUser(db, { email: 'sam@herriman.example', display_name: 'Sam Crew' }, { actorUserId: admin.id });
  grantRole(db, { userId: sam.id, roleId: 'field_crew' }, { actorUserId: admin.id });
  const gisLog = createGisLogger(db);
  const bsLog = createBlueStakesLogger(db);
  const call = (log, finished, outcome, error = null) => log({
    operation: 'test', ...(log === gisLog ? { asset_id: null } : { ticket_number: null }), attempt: 1, outcome, error,
    started_at: finished, finished_at: finished, duration_ms: 0,
  });
  const vendorCall = (vendor, finished, outcome, error = null) => logExchange(db, {
    vendor, clientName: `${vendor}-test`, outcome, error, startedAt: finished, finishedAt: finished,
  });
  const status = (name) => integrationStatus(db).items.find((i) => i.name === name);
  const gisWith = (backend) => createGisClient(backend, { log: gisLog, timeoutMs: 200, attempts: 2, delayMs: 1 });
  return { db, admin, sam, gisLog, bsLog, call, vendorCall, status, gisWith };
}

// ---------- AC1: each integration shows its vendor, status and the time of its last successful call ----------

test('every configured integration is listed with its vendor, status and last successful call', () => {
  const { call, gisLog, bsLog, vendorCall, status, db } = setup();
  call(gisLog, '2026-11-10T09:00:00.000Z', 'ok');
  call(bsLog, '2026-11-10T09:05:00.000Z', 'ok');
  vendorCall('madison_ai', '2026-11-10T09:10:00.000Z', 'ok');

  const items = integrationStatus(db, { connections: { gis: 'stand_in' } }).items;
  assert.deepEqual(items.map((i) => i.name), Object.keys(INTEGRATIONS));
  assert.deepEqual(items.map((i) => i.vendor), ['City GIS', 'Blue Stakes of Utah', 'Madison AI', 'Lama', 'SpryPoint']);
  assert.deepEqual([status('gis').status, status('gis').last_success_at], ['healthy', '2026-11-10T09:00:00.000Z']);
  assert.equal(items[0].connection, 'stand_in', 'shows how the system was started: a stand-in is never passed off as live');
  assert.deepEqual([status('bluestakes').status, status('bluestakes').last_success_at], ['healthy', '2026-11-10T09:05:00.000Z']);
  assert.deepEqual([status('madison_ai').status, status('madison_ai').last_success_at], ['healthy', '2026-11-10T09:10:00.000Z']);
});

test('an integration that has never been called says so, with no last successful call', () => {
  const { status } = setup();
  for (const name of Object.keys(INTEGRATIONS)) {
    const s = status(name);
    assert.deepEqual([s.status, s.last_success_at, s.last_call_at, s.calls_on_record], ['never_called', null, null, 0], name);
  }
});

test('a call that failed once and succeeded on retry is healthy', () => {
  const { call, gisLog, status } = setup();
  call(gisLog, '2026-11-10T09:00:00.000Z', 'timeout', 'GIS getAsset() timed out after 5000 ms');
  call(gisLog, '2026-11-10T09:00:01.000Z', 'ok');
  assert.equal(status('gis').status, 'healthy');
});

// ---------- AC2: a failed integration is flagged with the error class and the time it began failing ----------

test('a failing integration shows the error class and when it began failing, and keeps its last success', () => {
  const { call, gisLog, status } = setup();
  call(gisLog, '2026-11-10T08:00:00.000Z', 'ok');
  call(gisLog, '2026-11-10T09:00:00.000Z', 'error', 'connection refused');
  call(gisLog, '2026-11-10T09:30:00.000Z', 'timeout', 'GIS getAsset() timed out after 5000 ms');
  const s = status('gis');
  assert.deepEqual([s.status, s.error_class, s.failing_since, s.last_success_at],
    ['failing', 'timeout', '2026-11-10T09:00:00.000Z', '2026-11-10T08:00:00.000Z']);
  assert.match(s.error, /timed out/);
});

test('an integration that has never succeeded is failing since its first call, with no last success', () => {
  const { call, bsLog, status } = setup();
  call(bsLog, '2026-11-10T09:00:00.000Z', 'unauthorized', 'Blue Stakes refused the credential (unauthorized)');
  call(bsLog, '2026-11-10T10:00:00.000Z', 'unauthorized', 'Blue Stakes refused the credential (unauthorized)');
  const s = status('bluestakes');
  assert.deepEqual([s.status, s.error_class, s.failing_since, s.last_success_at], ['failing', 'unauthorized', '2026-11-10T09:00:00.000Z', null]);
});

test('a vendor feed that answered with records breaking the vendor contract is flagged as a mismatch', () => {
  const { vendorCall, status } = setup();
  vendorCall('lama', '2026-11-10T09:00:00.000Z', 'ok');
  vendorCall('lama', '2026-11-10T10:00:00.000Z', 'mismatch', 'item 3: status is not one of the contract values');
  const s = status('lama');
  assert.deepEqual([s.status, s.error_class, s.failing_since], ['failing', 'mismatch', '2026-11-10T10:00:00.000Z']);
  assert.equal(status('sprypoint').status, 'never_called', 'one vendor\'s calls never count for another');
});

// ---------- Trust: every status is read from a real call result, never a stored flag ----------

test('the status follows the latest real call: it recovers when a call succeeds and fails again when one fails', () => {
  const { call, gisLog, status } = setup();
  call(gisLog, '2026-11-10T09:00:00.000Z', 'error', 'down');
  assert.equal(status('gis').status, 'failing');
  call(gisLog, '2026-11-10T09:10:00.000Z', 'ok');
  assert.equal(status('gis').status, 'healthy');
  call(gisLog, '2026-11-10T09:20:00.000Z', 'error', 'down again');
  assert.deepEqual([status('gis').status, status('gis').failing_since], ['failing', '2026-11-10T09:20:00.000Z']);
});

test('no status is stored anywhere: the only new table holds check results, not statuses', () => {
  const { db } = setup();
  const columns = db.prepare('PRAGMA table_info(integration_checks)').all().map((c) => c.name);
  assert.deepEqual(columns, ['id', 'integration', 'requested_by', 'outcome', 'error', 'started_at', 'finished_at', 'duration_ms']);
});

// ---------- Check now: a real call, with a timeout, capped retries and a record of who asked ----------

test('check now makes a real read-only GIS call, and records the check and who asked', async () => {
  const { db, admin, gisWith, status } = setup();
  const result = await checkIntegration(db, 'gis', { gis: gisWith(createStandInGis(loadStandInAssets())), actorUserId: admin.id });
  assert.equal(result.check.outcome, 'ok');
  assert.equal(result.status.status, 'healthy');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gis_log WHERE operation = 'getChangesSince' AND outcome = 'ok'").get().n, 1, 'the call is in the GIS log');
  const audit = db.prepare("SELECT actor, actor_user_id, after_json FROM audit_entries WHERE entity_type = 'integration_check'").get();
  assert.deepEqual([audit.actor, audit.actor_user_id, JSON.parse(audit.after_json).outcome], ['jane.admin@herriman.example', admin.id, 'ok']);
  assert.equal(status('gis').last_success_at, result.check.finished_at, 'the check is now the last successful call');
});

test('a GIS reply that succeeds but has an unexpected shape is flagged, even though the call itself answered', async () => {
  const { db, admin, call, gisLog, gisWith, status } = setup();
  call(gisLog, '2026-11-10T08:00:00.000Z', 'ok');
  const odd = { kind: 'stand-in', getChangesSince: async () => ({ items: [] }) };
  const { check } = await checkIntegration(db, 'gis', { gis: gisWith(odd), actorUserId: admin.id });
  assert.deepEqual([check.outcome, check.error], ['unexpected_payload', 'GIS answered, but the reply has no list of changes']);
  const s = status('gis');
  assert.deepEqual([s.status, s.error_class, s.last_success_at], ['failing', 'unexpected_payload', '2026-11-10T08:00:00.000Z'],
    'the wrong-shaped reply does not count as a success');
});

test('the shape check names what is wrong in a GIS reply', () => {
  assert.equal(gisChangesProblem({ changes: [] }), null);
  assert.equal(gisChangesProblem({ changes: [{ seq: 1, asset_id: 'SL-0001' }] }), null);
  assert.equal(gisChangesProblem(null), 'the reply has no list of changes');
  assert.equal(gisChangesProblem({ changes: [{ seq: 1, asset_id: 'A' }, { seq: '2', asset_id: 'B' }] }), 'change 2 has no whole-number seq or no asset_id');
});

test('when GIS is down, check now retries a capped number of times, then records the failure', async () => {
  const { db, admin, gisWith, status } = setup();
  let tries = 0;
  const down = { kind: 'stand-in', getChangesSince: async () => { tries += 1; throw new GisError('connection refused'); } };
  const { check } = await checkIntegration(db, 'gis', { gis: gisWith(down), actorUserId: admin.id });
  assert.deepEqual([check.outcome, tries], ['error', 2], 'two attempts, then stop');
  assert.deepEqual([status('gis').status, status('gis').error_class], ['failing', 'error']);
});

test('check now is refused for someone without readiness review, and for integrations with no read-only call', async () => {
  const { db, admin, sam, gisWith } = setup();
  const gis = gisWith(createStandInGis(loadStandInAssets()));
  await assert.rejects(checkIntegration(db, 'gis', { gis, actorUserId: sam.id }), AccessDeniedError);
  await assert.rejects(checkIntegration(db, 'bluestakes', { gis, actorUserId: admin.id }), (e) => e instanceof ValidationError && /no read-only call/.test(e.message));
  await assert.rejects(checkIntegration(db, 'gis', { gis: null, actorUserId: admin.id }), /not connected/);
  await assert.rejects(checkIntegration(db, 'nowhere', { gis, actorUserId: admin.id }), /No integration nowhere/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM integration_checks').get().n, 0, 'nothing recorded for a refused check');
});

test('if the check cannot be recorded, no result is given', async () => {
  const { db, admin, gisWith } = setup();
  const failing = () => { throw new Error('audit unavailable'); };
  await assert.rejects(checkIntegration(db, 'gis', { gis: gisWith(createStandInGis(loadStandInAssets())), actorUserId: admin.id, audit: failing }), /audit unavailable/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM integration_checks').get().n, 0, 'the check row was rolled back with the audit entry');
});

// ---------- AC3: each readiness check shows pass or fail with the evidence behind it ----------

test('before any assessment, automatic checks show as not run with no evidence; manual items with nothing recorded fail', () => {
  const { db } = setup();
  const view = readinessView(db);
  assert.equal(view.assessment, null);
  assert.ok(view.checks.filter((c) => c.kind === 'automatic').every((c) => c.result === 'not_run' && !c.passed));
  assert.ok(view.checks.filter((c) => c.kind === 'manual').every((c) => c.result === 'fail' && c.evidence === 'no evidence recorded'));
});

test('after an assessment, each check shows pass or fail with what it found', async () => {
  const { db, admin } = setup();
  issueUserKey(db, admin.id, { actorUserId: admin.id }); // the administrator check needs someone who can sign in
  await runAssessment(db, { actorUserId: admin.id, connections: { gis: 'stand_in', bluestakes: 'stand_in' } });
  const view = readinessView(db);
  assert.equal(view.assessment.reviewer_email, 'jane.admin@herriman.example');
  const byKey = Object.fromEntries(view.checks.map((c) => [c.key, c]));
  assert.deepEqual([byKey['configuration.administrator'].result, byKey['configuration.administrator'].evidence], ['pass', '1 active administrator(s)']);
  assert.deepEqual([byKey['configuration.gis_connection'].result, byKey['configuration.gis_connection'].evidence],
    ['fail', 'GIS is running on a stand-in, not the real service']);
  assert.ok(view.checks.every((c) => ['pass', 'fail', 'no_evidence'].includes(c.result) && c.evidence));
});

test('a readiness item marked done with no evidence recorded is shown as no evidence, not as a pass', () => {
  const { db, admin } = setup();
  recordItem(db, 'testing.staff_trained', { status: 'done' }, { actorUserId: admin.id });
  recordItem(db, 'testing.user_acceptance', { status: 'done', note: 'Signed off by the Streets supervisor, 2027-05-03' }, { actorUserId: admin.id });
  const byKey = Object.fromEntries(readinessView(db).checks.map((c) => [c.key, c]));
  assert.deepEqual([byKey['testing.staff_trained'].result, byKey['testing.staff_trained'].passed, byKey['testing.staff_trained'].evidence],
    ['no_evidence', false, 'no evidence recorded']);
  assert.deepEqual([byKey['testing.user_acceptance'].result, byKey['testing.user_acceptance'].evidence],
    ['pass', 'Signed off by the Streets supervisor, 2027-05-03']);
  assert.equal(readinessView(db).summary.no_evidence, 1);
});
