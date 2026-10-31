// STORY-006 — workflows that adapt: the existing one keeps working, new ones can be added safely.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../server/db.js';
import {
  ValidationError, ConflictError, VersionConflictError, writeAudit, createWorkOrder, completeWorkOrder, updateWorkOrder, getWorkOrder,
} from '../server/workOrders.js';
import {
  validateWorkflow, publishWorkflow, getActiveWorkflow, workflowForWorkType, transitionWorkOrder, WorkflowNotSavedError, STANDARD_KEY,
} from '../server/workflows.js';

/** A realistic pothole workflow, with a loop back if inspection fails. */
const pothole = (extra = {}) => ({
  key: 'pothole_repair',
  name: 'Pothole repair',
  work_type: 'pothole',
  steps: [
    { key: 'received', name: 'Received', next: ['assessed'] },
    { key: 'assessed', name: 'Assessed', next: ['scheduled', 'completed'] },
    { key: 'scheduled', name: 'Scheduled', next: ['in_progress'] },
    { key: 'in_progress', name: 'In progress', next: ['inspected'] },
    { key: 'inspected', name: 'Inspected', next: ['completed', 'in_progress'] },
    { key: 'completed', name: 'Completed', next: [], final: true },
  ],
  ...extra,
});
const workflowAudits = (db) => db.prepare("SELECT * FROM audit_entries WHERE entity_type = 'workflow' ORDER BY id").all();
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

// ---------- the existing workflow ----------

test('the built-in Standard workflow is today\'s behaviour — open, then completed — and covers every work type', () => {
  const db = openDatabase();
  const std = getActiveWorkflow(db, STANDARD_KEY);
  assert.deepEqual(std.steps.map((s) => [s.key, s.final, s.next]), [['open', false, ['completed']], ['completed', true, []]]);
  assert.equal(workflowForWorkType(db, 'anything').workflow_key, STANDARD_KEY);
  assert.throws(() => publishWorkflow(db, { ...pothole(), key: STANDARD_KEY }, { actor: 'admin-1' }), /built in and cannot be changed/);
});

// ---------- publishing a new workflow ----------

test('a valid workflow is published as version 1, saved with its steps, and audited with the user id', () => {
  const db = openDatabase();
  const wf = publishWorkflow(db, pothole(), { actor: 'admin-1' });
  assert.equal(wf.version, 1);
  assert.equal(wf.status, 'active');
  assert.equal(wf.unchanged, false);
  assert.deepEqual(wf.steps.map((s) => s.key), ['received', 'assessed', 'scheduled', 'in_progress', 'inspected', 'completed']);
  assert.deepEqual(wf.steps.find((s) => s.key === 'inspected').next, ['completed', 'in_progress']);
  assert.equal(workflowForWorkType(db, 'pothole').id, wf.id, 'new pothole work orders will follow it');
  assert.equal(workflowForWorkType(db, 'streetlight').workflow_key, STANDARD_KEY, 'other work types are unaffected');

  const [audit] = workflowAudits(db);
  assert.equal(audit.action, 'publish');
  assert.equal(audit.actor, 'admin-1');
  assert.ok(!Number.isNaN(Date.parse(audit.occurred_at)));
  assert.equal(JSON.parse(audit.after_json).steps.length, 6);
});

test('changing a workflow publishes version 2; version 1 is kept, marked superseded', () => {
  const db = openDatabase();
  const v1 = publishWorkflow(db, pothole(), { actor: 'admin-1' });
  const changed = pothole();
  changed.steps.splice(2, 0, { key: 'traffic_plan', name: 'Traffic plan approved', next: ['scheduled'] });
  changed.steps[1].next = ['traffic_plan', 'completed'];
  const v2 = publishWorkflow(db, changed, { actor: 'admin-2' });

  assert.equal(v2.version, 2);
  assert.equal(getActiveWorkflow(db, 'pothole_repair').id, v2.id);
  assert.equal(db.prepare('SELECT status FROM workflows WHERE id = ?').get(v1.id).status, 'superseded');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workflow_steps WHERE workflow_id = ?').get(v1.id).n, 6, 'version 1 steps are kept');
  const second = workflowAudits(db)[1];
  assert.equal(second.actor, 'admin-2');
  assert.equal(JSON.parse(second.before_json).version, 1);
});

test('publishing the same definition twice changes nothing', () => {
  const db = openDatabase();
  const first = publishWorkflow(db, pothole(), { actor: 'admin-1' });
  const again = publishWorkflow(db, pothole(), { actor: 'admin-1' });
  assert.equal(again.unchanged, true);
  assert.equal(again.id, first.id);
  assert.equal(count(db, 'workflows'), 2, 'Standard + one pothole version');
  assert.equal(workflowAudits(db).length, 1);
});

// ---------- failure path: incompatible changes ----------

test('incompatible workflows are refused with every problem listed, and nothing is saved', () => {
  const db = openDatabase();
  const cases = [
    [{ ...pothole(), steps: pothole().steps.map((s) => ({ ...s, final: false })) }, /exactly one step must be final/],
    [{ ...pothole(), steps: [{ key: 'start', name: 'Start', next: ['finish'], final: true }, { key: 'finish', name: 'Finish', next: [] }] }, /first step cannot be the final step/],
    [{ ...pothole(), steps: [...pothole().steps.slice(0, 5), { key: 'completed', name: 'Done', next: ['received'], final: true }] }, /final step cannot move anywhere/],
    [{ ...pothole(), steps: pothole().steps.map((s) => (s.key === 'scheduled' ? { ...s, next: [] } : s)) }, /scheduled: is a dead end/],
    [{ ...pothole(), steps: pothole().steps.map((s) => (s.key === 'received' ? { ...s, next: ['nowhere'] } : s)) }, /moves to nowhere, which is not a step/],
    [{ ...pothole(), steps: [...pothole().steps, { key: 'orphan', name: 'Orphan', next: ['completed'] }] }, /orphan: can never be reached/],
    [{
      ...pothole(),
      steps: [
        { key: 'received', name: 'Received', next: ['loop_a', 'completed'] },
        { key: 'loop_a', name: 'Loop A', next: ['loop_b'] },
        { key: 'loop_b', name: 'Loop B', next: ['loop_a'] },
        { key: 'completed', name: 'Completed', next: [], final: true },
      ],
    }, /loop_a: has no way to reach completed/],
    [{ ...pothole(), steps: pothole().steps.map((s) => (s.key === 'assessed' ? { ...s, name: 'Received' } : s)) }, /step name "Received" is used twice/],
    [{ ...pothole(), steps: pothole().steps.map((s) => (s.key === 'scheduled' ? { ...s, next: ['scheduled', 'in_progress'] } : s)) }, /cannot move to itself/],
    [{ ...pothole(), work_type: '' }, /work_type is required/],
    [{ ...pothole(), key: 'Bad Key' }, /key must be/],
    [{ ...pothole(), steps: [{ key: 'only', name: 'Only', next: [], final: true }] }, /needs 2 to 30 steps/],
  ];
  for (const [def, expected] of cases) {
    assert.throws(() => publishWorkflow(db, def, { actor: 'admin-1' }), (err) => err instanceof ValidationError && err.problems.some((p) => expected.test(p)), String(expected));
  }
  assert.equal(count(db, 'workflows'), 1, 'only the built-in Standard workflow');
  assert.equal(workflowAudits(db).length, 0);
  assert.deepEqual(validateWorkflow(pothole()), []);
});

test('two different workflows cannot both claim the same work type', () => {
  const db = openDatabase();
  publishWorkflow(db, pothole(), { actor: 'admin-1' });
  assert.throws(() => publishWorkflow(db, { ...pothole(), key: 'pothole_fast' }, { actor: 'admin-1' }), ConflictError);
});

// ---------- failure path: workflow not saved ----------

test('if the audit entry cannot be written, the workflow is not saved', () => {
  const db = openDatabase();
  const failing = () => { throw new Error('audit store unavailable'); };
  assert.throws(() => publishWorkflow(db, pothole(), { actor: 'admin-1', audit: failing }), /audit store unavailable/);
  assert.equal(count(db, 'workflows'), 1);
  assert.equal(workflowForWorkType(db, 'pothole').workflow_key, STANDARD_KEY);
});

test('if what was stored does not match what was sent, nothing is kept', () => {
  const db = openDatabase();
  const tampering = (d, entry) => {
    d.prepare("UPDATE workflow_steps SET name = 'Tampered' WHERE workflow_id = ? AND step_key = 'assessed'").run(entry.entityId);
    writeAudit(d, entry);
  };
  assert.throws(() => publishWorkflow(db, pothole(), { actor: 'admin-1', audit: tampering }), WorkflowNotSavedError);
  assert.equal(count(db, 'workflows'), 1);
  assert.equal(count(db, 'workflow_steps'), 2, 'only Standard\'s two steps');
});

test('a change needs the user making it', () => {
  const db = openDatabase();
  assert.throws(() => publishWorkflow(db, pothole(), {}), /actor is required/);
});

// ---------- work orders following a workflow ----------

const newOrder = (db, workType = 'pothole') => createWorkOrder(db, {
  title: 'Pothole on Main St', created_by: 'clerk-1', work_type: workType, location_text: '5355 W Herriman Main St',
});
const transitions = (db, id) => db.prepare("SELECT * FROM audit_entries WHERE entity_type = 'work_order' AND entity_id = ? AND action = 'transition' ORDER BY id").all(id);

test('a work type with no workflow of its own follows Standard and completes exactly as before', async () => {
  const db = openDatabase();
  const wo = await newOrder(db, 'streetlight');
  assert.equal(wo.workflow_id, 'wf-standard-1');
  assert.equal(wo.current_step, 'open');
  const done = await completeWorkOrder(db, wo.id, { note: 'Bulb replaced', actor: 'crew-1' });
  assert.equal(done.status, 'completed');
  assert.equal(done.current_step, 'completed');
});

test('a new work order starts on the first step of its work type\'s workflow', async () => {
  const db = openDatabase();
  const wf = publishWorkflow(db, pothole(), { actor: 'admin-1' });
  const wo = await newOrder(db);
  assert.equal(wo.workflow_id, wf.id);
  assert.equal(wo.current_step, 'received');
  assert.equal(wo.status, 'open');
});

test('a work order moves only to the steps its current step allows, and every move is audited', async () => {
  const db = openDatabase();
  publishWorkflow(db, pothole(), { actor: 'admin-1' });
  const wo = await newOrder(db);
  const moved = transitionWorkOrder(db, wo.id, { to: 'assessed', actor: 'crew-1', expectedVersion: wo.version });
  assert.equal(moved.current_step, 'assessed');
  assert.equal(moved.version, wo.version + 1);
  assert.equal(moved.status, 'open', 'steps before the final one count as open');

  assert.throws(() => transitionWorkOrder(db, wo.id, { to: 'inspected', actor: 'crew-1' }), /cannot move to "Inspected". It can move to: Scheduled, Completed/);
  assert.throws(() => transitionWorkOrder(db, wo.id, { to: 'nowhere', actor: 'crew-1' }), ValidationError);
  assert.throws(() => transitionWorkOrder(db, wo.id, { to: 'completed', actor: 'crew-1' }), /complete it with a note/);
  assert.equal(getWorkOrder(db, wo.id).current_step, 'assessed', 'refused moves change nothing');

  const all = transitions(db, wo.id);
  assert.equal(all.length, 1);
  assert.equal(all[0].actor, 'crew-1');
  assert.equal(JSON.parse(all[0].before_json).current_step, 'received');
  assert.equal(JSON.parse(all[0].after_json).current_step, 'assessed');
  assert.ok(!Number.isNaN(Date.parse(all[0].occurred_at)));
});

test('completion is only allowed from a step that leads to the final step', async () => {
  const db = openDatabase();
  publishWorkflow(db, pothole(), { actor: 'admin-1' });
  const wo = await newOrder(db);
  await assert.rejects(completeWorkOrder(db, wo.id, { note: 'Filled', actor: 'crew-1' }), /at "Received" and can only be completed from Assessed or Inspected/);
  transitionWorkOrder(db, wo.id, { to: 'assessed', actor: 'crew-1' });
  const done = await completeWorkOrder(db, wo.id, { note: 'Minor, filled on the spot', actor: 'crew-1' });
  assert.equal(done.status, 'completed');
  assert.equal(done.current_step, 'completed');
  assert.throws(() => transitionWorkOrder(db, wo.id, { to: 'assessed', actor: 'crew-1' }), /completed work order cannot be moved/);
});

test('work under way stays on its workflow version when a new version is published', async () => {
  const db = openDatabase();
  const v1 = publishWorkflow(db, pothole(), { actor: 'admin-1' });
  const early = await newOrder(db);
  transitionWorkOrder(db, early.id, { to: 'assessed', actor: 'crew-1' });

  const changed = pothole();
  changed.steps.splice(2, 0, { key: 'traffic_plan', name: 'Traffic plan approved', next: ['scheduled'] });
  changed.steps[1].next = ['traffic_plan']; // v2: after assessment, a traffic plan is always needed
  const v2 = publishWorkflow(db, changed, { actor: 'admin-1' });
  const late = await newOrder(db);

  assert.equal(getWorkOrder(db, early.id).workflow_id, v1.id);
  assert.equal(late.workflow_id, v2.id);
  transitionWorkOrder(db, early.id, { to: 'scheduled', actor: 'crew-1' }); // still allowed under v1
  transitionWorkOrder(db, late.id, { to: 'assessed', actor: 'crew-1' });
  assert.throws(() => transitionWorkOrder(db, late.id, { to: 'scheduled', actor: 'crew-1' }), /can move to: Traffic plan approved/);
});

test('a move with an out-of-date version is refused', async () => {
  const db = openDatabase();
  publishWorkflow(db, pothole(), { actor: 'admin-1' });
  const wo = await newOrder(db);
  await updateWorkOrder(db, wo.id, { priority: 'high' }, { actor: 'clerk-2' });
  assert.throws(() => transitionWorkOrder(db, wo.id, { to: 'assessed', actor: 'crew-1', expectedVersion: wo.version }), VersionConflictError);
  assert.equal(getWorkOrder(db, wo.id).current_step, 'received');
});

test('if the audit entry for a move cannot be written, the move is not saved', async () => {
  const db = openDatabase();
  publishWorkflow(db, pothole(), { actor: 'admin-1' });
  const wo = await newOrder(db);
  const failing = () => { throw new Error('audit store unavailable'); };
  assert.throws(() => transitionWorkOrder(db, wo.id, { to: 'assessed', actor: 'crew-1', audit: failing }), /audit store unavailable/);
  const after = getWorkOrder(db, wo.id);
  assert.equal(after.current_step, 'received');
  assert.equal(after.version, wo.version);
});

test('work orders saved before workflows existed are put on Standard, at the right step', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hwo-wf-'));
  const file = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE work_orders (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, work_type TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal', status TEXT NOT NULL DEFAULT 'open', location_text TEXT, address TEXT,
      latitude REAL, longitude REAL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      completed_at TEXT, completion_note TEXT, request_id TEXT UNIQUE, is_public INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1);
      INSERT INTO work_orders (id, title, work_type, status, created_by, created_at, updated_at, completed_at, version) VALUES
        ('a', 'Open one', 'pothole', 'open', 'u', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', NULL, 3),
        ('b', 'Done one', 'pothole', 'completed', 'u', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z', 2);`);
    old.close();

    const db = openDatabase(file);
    const a = getWorkOrder(db, 'a');
    const b = getWorkOrder(db, 'b');
    assert.deepEqual([a.workflow_id, a.current_step, a.step_entered_at, a.version], ['wf-standard-1', 'open', '2026-10-01T00:00:00Z', 3]);
    assert.deepEqual([b.workflow_id, b.current_step, b.step_entered_at, b.version], ['wf-standard-1', 'completed', '2026-10-02T00:00:00Z', 2]);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
