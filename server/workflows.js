// Workflows (STORY-006, REQ-045): the steps a work order goes through, defined by administrators.
//
// "Comply with existing workflows": the built-in Standard workflow (Open → Completed) is how work
// orders have always behaved, and it applies to every work type without a workflow of its own.
// "Accommodate new workflows": an administrator publishes a workflow for a work type. Changing it
// publishes a new version; work orders already under way stay on the version they started with, so
// a change can never strand them on a step that no longer exists.
//
// A workflow is only accepted if it can always end in completion (see validateWorkflow): every step
// is reachable from the first, every step can reach the final step, and nothing is a dead end. That
// keeps the SAFE guardrail — work orders can always be completed.

import { createHash, randomUUID } from 'node:crypto';
import { inTransaction } from './db.js';
import {
  writeAudit, getWorkOrder, ValidationError, ConflictError, NotFoundError, VersionConflictError,
} from './workOrders.js';
// workOrders.js imports this module too; that is safe because neither uses the other's exports until a function runs.

export const STANDARD_KEY = 'standard';
const KEY_PATTERN = /^[a-z][a-z0-9_]{1,40}$/;
const MAX_STEPS = 30;
const defaultNow = () => new Date().toISOString();

/** The workflow could not be confirmed as saved exactly as sent. Nothing was kept. */
export class WorkflowNotSavedError extends Error {
  constructor(detail) {
    super(`The workflow could not be confirmed as saved: ${detail}. Please publish it again.`);
    this.name = 'WorkflowNotSavedError';
  }
}

// ---------- checking a definition ----------

/** Every step that can be reached from `from` by following next-steps. */
function reachableFrom(from, nextOf) {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    for (const n of nextOf.get(queue.shift()) ?? []) {
      if (!seen.has(n)) { seen.add(n); queue.push(n); }
    }
  }
  return seen;
}

/**
 * Problems with a workflow definition; an empty list means it is safe to publish.
 * Definition: { key, name, work_type, steps: [{ key, name, next: [stepKey…], final? }] } — the first step is where work orders start.
 */
export function validateWorkflow(def) {
  if (def === null || typeof def !== 'object' || Array.isArray(def)) return ['the workflow must be an object'];
  const problems = [];
  if (typeof def.key !== 'string' || !KEY_PATTERN.test(def.key)) problems.push('key must be 2–41 lowercase letters, digits or _ and start with a letter');
  else if (def.key === STANDARD_KEY) problems.push('the Standard workflow is built in and cannot be changed');
  if (typeof def.name !== 'string' || def.name.trim().length < 2 || def.name.trim().length > 80) problems.push('name must be 2 to 80 characters');
  if (typeof def.work_type !== 'string' || !def.work_type.trim()) problems.push('work_type is required (the work type this workflow is for)');

  const steps = Array.isArray(def.steps) ? def.steps : null;
  if (!steps) return [...problems, 'steps must be a list'];
  if (steps.length < 2 || steps.length > MAX_STEPS) problems.push(`a workflow needs 2 to ${MAX_STEPS} steps`);

  const keys = new Set();
  const names = new Set();
  for (const [i, s] of steps.entries()) {
    const label = `steps[${i}]`;
    if (typeof s?.key !== 'string' || !KEY_PATTERN.test(s.key)) problems.push(`${label}: key must be 2–41 lowercase letters, digits or _`);
    else if (keys.has(s.key)) problems.push(`${label}: step key ${s.key} is used twice`);
    else keys.add(s.key);
    const name = typeof s?.name === 'string' ? s.name.trim() : '';
    if (!name) problems.push(`${label}: name is required`);
    else if (names.has(name.toLowerCase())) problems.push(`${label}: step name "${name}" is used twice`);
    else names.add(name.toLowerCase());
    if (!Array.isArray(s?.next) || !s.next.every((n) => typeof n === 'string')) problems.push(`${label}: next must be a list of step keys`);
  }
  if (problems.length) return problems;

  const finals = steps.filter((s) => s.final === true);
  if (finals.length !== 1) problems.push('exactly one step must be final (the step that completes the work order)');
  if (steps[0].final === true) problems.push('the first step cannot be the final step');

  const nextOf = new Map(steps.map((s) => [s.key, [...new Set(s.next)]]));
  for (const s of steps) {
    for (const n of s.next) {
      if (!keys.has(n)) problems.push(`step ${s.key}: moves to ${n}, which is not a step in this workflow`);
      if (n === s.key) problems.push(`step ${s.key}: cannot move to itself`);
    }
    if (s.final === true && s.next.length) problems.push(`step ${s.key}: the final step cannot move anywhere`);
    if (s.final !== true && !s.next.length) problems.push(`step ${s.key}: is a dead end — it must move somewhere`);
  }
  if (problems.length) return problems;

  const reached = reachableFrom(steps[0].key, nextOf);
  for (const s of steps) if (!reached.has(s.key)) problems.push(`step ${s.key}: can never be reached from ${steps[0].key}`);
  const finalKey = finals[0].key;
  for (const s of steps) {
    if (s.key !== finalKey && !reachableFrom(s.key, nextOf).has(finalKey)) problems.push(`step ${s.key}: has no way to reach ${finalKey}, so a work order there could never be completed`);
  }
  return problems;
}

/** Fingerprint of the steps exactly as they will be stored. */
function fingerprint(def) {
  const steps = def.steps.map((s) => [s.key, s.name.trim(), [...new Set(s.next)], s.final === true]);
  return createHash('sha256').update(JSON.stringify([def.name.trim(), def.work_type.trim(), steps])).digest('hex');
}

// ---------- reading ----------

function stepsOf(db, workflowId) {
  return db.prepare('SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY position').all(workflowId)
    .map((s) => ({ key: s.step_key, name: s.name, position: s.position, final: s.is_final === 1, next: JSON.parse(s.next_steps_json), required_role: s.required_role }));
}

/** A workflow version with its steps. */
export function getWorkflow(db, id) {
  const wf = db.prepare('SELECT * FROM workflows WHERE id = ?').get(String(id ?? ''));
  return wf ? { ...wf, steps: stepsOf(db, wf.id) } : null;
}

/** The active version of a workflow, by key. */
export function getActiveWorkflow(db, key) {
  const wf = db.prepare("SELECT id FROM workflows WHERE workflow_key = ? AND status = 'active'").get(String(key ?? ''));
  return wf ? getWorkflow(db, wf.id) : null;
}

/** The workflow a new work order of this type should follow: its own active workflow, else Standard. */
export function workflowForWorkType(db, workType) {
  const own = db.prepare("SELECT id FROM workflows WHERE work_type = ? AND status = 'active'").get(String(workType ?? ''));
  return getWorkflow(db, own?.id ?? 'wf-standard-1');
}

// ---------- publishing ----------

/**
 * Publish a workflow (a new key, or a new version of an existing one). The new version becomes the
 * one new work orders use; the previous version is marked superseded but work orders on it keep it.
 *
 * - Invalid or incompatible: ValidationError listing every problem, nothing saved.
 * - Another workflow already covers this work type: ConflictError.
 * - Identical to the current version: that version is returned with unchanged: true (safe to send twice).
 * - Otherwise saved with its audit entry, read back and fingerprint-checked inside the transaction.
 *
 * `audit` is only replaceable so tests can prove the rollback.
 */
export function publishWorkflow(db, def, { actor, now = defaultNow, audit = writeAudit } = {}) {
  if (typeof actor !== 'string' || !actor.trim()) throw new ValidationError(['actor is required (the user making the change)']);
  const problems = validateWorkflow(def);
  if (problems.length) throw new ValidationError(problems);
  const sha = fingerprint(def);

  const id = inTransaction(db, () => {
    const current = db.prepare("SELECT * FROM workflows WHERE workflow_key = ? AND status = 'active'").get(def.key);
    if (current?.definition_sha256 === sha) return { id: current.id, unchanged: true };

    const clash = db.prepare("SELECT workflow_key FROM workflows WHERE work_type = ? AND status = 'active' AND workflow_key != ?").get(def.work_type.trim(), def.key);
    if (clash) throw new ConflictError(`Work type ${def.work_type.trim()} already follows the workflow ${clash.workflow_key}. Retire it first, or publish a new version of it.`);

    const latest = db.prepare('SELECT MAX(version) AS v FROM workflows WHERE workflow_key = ?').get(def.key).v ?? 0;
    const at = now();
    const row = {
      id: randomUUID(), workflow_key: def.key, version: latest + 1, name: def.name.trim(), work_type: def.work_type.trim(),
      status: 'active', definition_sha256: sha, created_by: actor.trim(), created_at: at,
    };
    if (current) db.prepare("UPDATE workflows SET status = 'superseded' WHERE id = ?").run(current.id);
    db.prepare(`INSERT INTO workflows (id, workflow_key, version, name, work_type, status, definition_sha256, created_by, created_at)
                VALUES (:id, :workflow_key, :version, :name, :work_type, :status, :definition_sha256, :created_by, :created_at)`).run(row);
    const insertStep = db.prepare(`INSERT INTO workflow_steps (workflow_id, step_key, position, name, is_final, next_steps_json)
                                   VALUES (?, ?, ?, ?, ?, ?)`);
    def.steps.forEach((s, i) => insertStep.run(row.id, s.key, i + 1, s.name.trim(), s.final === true ? 1 : 0, JSON.stringify([...new Set(s.next)])));
    audit(db, {
      entityType: 'workflow', entityId: row.id, action: 'publish', actor: actor.trim(),
      before: current ? { workflow_id: current.id, version: current.version } : null,
      after: { ...row, steps: def.steps }, at,
    });

    // Read it back: if what was stored is not exactly what was sent, roll everything back.
    const stored = getWorkflow(db, row.id);
    const storedDef = { name: stored.name, work_type: stored.work_type, steps: stored.steps };
    if (fingerprint(storedDef) !== sha) throw new WorkflowNotSavedError('what was stored does not match what was sent');
    return { id: row.id, unchanged: false };
  });

  const saved = getWorkflow(db, id.id);
  if (!saved) throw new WorkflowNotSavedError('it was not found after saving');
  return { ...saved, unchanged: id.unchanged };
}

/**
 * Retire a workflow: new work orders of its work type go back to Standard. Work orders already on
 * it keep it and can still be moved and completed. Audited with the user and time.
 */
export function retireWorkflow(db, key, { actor, now = defaultNow, audit = writeAudit } = {}) {
  if (typeof actor !== 'string' || !actor.trim()) throw new ValidationError(['actor is required (the user making the change)']);
  if (key === STANDARD_KEY) throw new ConflictError('The Standard workflow is built in and cannot be retired.');
  return inTransaction(db, () => {
    const current = db.prepare("SELECT * FROM workflows WHERE workflow_key = ? AND status = 'active'").get(String(key ?? ''));
    if (!current) {
      const err = new NotFoundError(key);
      err.message = `No active workflow ${key}`;
      throw err;
    }
    const at = now();
    db.prepare("UPDATE workflows SET status = 'retired' WHERE id = ?").run(current.id);
    audit(db, {
      entityType: 'workflow', entityId: current.id, action: 'retire', actor: actor.trim(),
      before: { status: 'active', version: current.version }, after: { status: 'retired', version: current.version }, at,
    });
    return getWorkflow(db, current.id);
  });
}

/** Every workflow, newest version first within each, with how many open work orders are on each version. */
export function listWorkflows(db) {
  const rows = db.prepare(`SELECT w.*, (SELECT COUNT(*) FROM work_orders o WHERE o.workflow_id = w.id AND o.status = 'open') AS open_work_orders
                           FROM workflows w ORDER BY w.workflow_key, w.version DESC`).all();
  const byKey = new Map();
  for (const r of rows) {
    if (!byKey.has(r.workflow_key)) byKey.set(r.workflow_key, { key: r.workflow_key, name: r.name, work_type: r.work_type, active_version: null, versions: [] });
    const entry = byKey.get(r.workflow_key);
    if (r.status === 'active') entry.active_version = r.version;
    entry.versions.push({ id: r.id, version: r.version, status: r.status, created_by: r.created_by, created_at: r.created_at, open_work_orders: r.open_work_orders });
  }
  return [...byKey.values()];
}

/** Where a work order is in its workflow, and where it can go next. */
export function workflowPosition(db, wo) {
  const workflow = getWorkflow(db, wo.workflow_id);
  const step = workflow.steps.find((s) => s.key === wo.current_step);
  const name = (k) => workflow.steps.find((s) => s.key === k).name;
  return {
    workflow_key: workflow.workflow_key,
    workflow_version: workflow.version,
    workflow_name: workflow.name,
    current_step: step.key,
    current_step_name: step.name,
    step_entered_at: wo.step_entered_at,
    // The final step is reached by completing (with a note), so it is listed separately.
    next_steps: step.next.filter((k) => !workflow.steps.find((s) => s.key === k).final).map((k) => ({ key: k, name: name(k) })),
    can_complete: step.next.some((k) => workflow.steps.find((s) => s.key === k).final),
  };
}

// ---------- moving a work order along its workflow ----------

/**
 * Move a work order to one of the steps its current step allows. The move and its audit entry
 * (user, time, from and to) are saved together or not at all.
 *
 * Reaching the final step is completion, which needs a note, so it is refused here: use
 * completeWorkOrder. Work orders keep the workflow version they started on, so a newer version
 * never changes what moves are allowed for work already under way.
 *
 * `audit` is only replaceable so tests can prove the rollback.
 */
export function transitionWorkOrder(db, id, { to, actor, now = defaultNow, audit = writeAudit, expectedVersion } = {}) {
  const problems = [];
  if (typeof actor !== 'string' || !actor.trim()) problems.push('actor is required');
  if (typeof to !== 'string' || !to.trim()) problems.push('the step to move to is required');
  if (expectedVersion !== undefined && !(Number.isInteger(expectedVersion) && expectedVersion >= 1)) problems.push('expected version must be a whole number of 1 or more');
  if (problems.length) throw new ValidationError(problems);
  const target = to.trim();

  inTransaction(db, () => {
    const before = getWorkOrder(db, id);
    if (!before) throw new NotFoundError(id);
    if (before.status === 'completed') throw new ConflictError('A completed work order cannot be moved.');
    if (expectedVersion !== undefined && before.version !== expectedVersion) throw new VersionConflictError(expectedVersion, before.version);

    const workflow = getWorkflow(db, before.workflow_id);
    const step = workflow.steps.find((s) => s.key === before.current_step);
    const next = workflow.steps.find((s) => s.key === target);
    if (!next) throw new ValidationError([`${target} is not a step in the workflow ${workflow.name} (version ${workflow.version})`]);
    if (next.final) throw new ConflictError(`Moving to "${next.name}" completes the work order — complete it with a note instead.`);
    if (!step.next.includes(target)) {
      const allowed = step.next.map((k) => workflow.steps.find((s) => s.key === k).name).join(', ');
      throw new ConflictError(`A work order at "${step.name}" cannot move to "${next.name}". It can move to: ${allowed}.`);
    }

    const at = now();
    db.prepare('UPDATE work_orders SET current_step = ?, step_entered_at = ?, updated_at = ?, version = version + 1 WHERE id = ?')
      .run(target, at, at, before.id);
    const after = getWorkOrder(db, before.id);
    audit(db, {
      entityType: 'work_order', entityId: before.id, action: 'transition', actor: actor.trim(),
      before: { ...before, step_name: step.name }, after: { ...after, step_name: next.name, workflow_version: workflow.version }, at,
    });
  });
  return getWorkOrder(db, id);
}
