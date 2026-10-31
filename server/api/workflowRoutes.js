// Workflows over HTTP (STORY-006, REQ-045).
//
//   GET  /api/v1/workflows               every workflow and its versions        (work_orders:read)
//   GET  /api/v1/workflows/{key}         the active version with its steps      (work_orders:read)
//   POST /api/v1/workflows               publish a workflow or a new version    (workflows:admin)
//   POST /api/v1/workflows/{key}/retire  retire it; its work type goes back to Standard (workflows:admin)
//
// Reading uses work_orders:read because anyone moving work orders along needs to see the steps.
// A definition that could strand work orders gets 422 with every problem listed; nothing is saved.
// Publishing and retiring are audited with "<actor> via <system>".

import { send, readJsonBody } from './http.js';
import { requireAccess, auditedRead, actorFor, READ_SCOPE, WORKFLOWS_ADMIN_SCOPE } from './clients.js';
import { ValidationError, NotFoundError } from '../workOrders.js';
import { publishWorkflow, retireWorkflow, listWorkflows, getActiveWorkflow, getWorkflow } from '../workflows.js';

export const WORKFLOWS_BASE = '/api/v1/workflows';
const ONE = new RegExp(`^${WORKFLOWS_BASE}/([^/]+)(?:/(retire))?$`);

// What each body may contain; also the source of the OpenAPI request bodies.
export const WORKFLOW_FIELDS = ['actor', 'key', 'name', 'work_type', 'steps'];
export const STEP_FIELDS = ['key', 'name', 'next', 'final', 'role'];

function unknownFields(body) {
  const problems = Object.keys(body).filter((f) => !WORKFLOW_FIELDS.includes(f)).map((f) => `${f} is not a field this endpoint accepts`);
  if (Array.isArray(body.steps)) {
    body.steps.forEach((s, i) => {
      if (s && typeof s === 'object') for (const f of Object.keys(s)) if (!STEP_FIELDS.includes(f)) problems.push(`steps[${i}].${f} is not a field a step accepts`);
    });
  }
  return problems;
}

/** The public shape of one workflow version. */
const view = (wf) => ({
  id: wf.id, key: wf.workflow_key, version: wf.version, name: wf.name, work_type: wf.work_type, status: wf.status,
  created_by: wf.created_by, created_at: wf.created_at,
  steps: wf.steps.map((s) => ({ key: s.key, name: s.name, next: s.next, final: s.final, role: s.role ?? null })),
});

export async function handleWorkflows(req, res, db, url, { key, now } = {}) {
  const opts = now ? { now } : {};
  const m = url.pathname === WORKFLOWS_BASE ? null : ONE.exec(url.pathname);
  if (url.pathname !== WORKFLOWS_BASE && !m) {
    send(res, 404, { error: 'not_found', message: `No endpoint at ${url.pathname}` });
    return;
  }
  const wfKey = m ? decodeURIComponent(m[1]) : null;
  const action = m?.[2] ?? null;
  const allowed = action ? 'POST' : (wfKey ? 'GET' : 'GET, POST');
  if (!allowed.split(', ').includes(req.method)) {
    send(res, 405, { error: 'method_not_allowed', message: `Use ${allowed} here` }, { Allow: allowed });
    return;
  }

  if (req.method === 'GET' && !wfKey) {
    send(res, 200, auditedRead(db, { key, operation: 'listWorkflows', scope: READ_SCOPE }, () => ({ items: listWorkflows(db) }), opts));
    return;
  }
  if (req.method === 'GET') {
    const body = auditedRead(db, { key, operation: 'getWorkflow', params: { key: wfKey }, scope: READ_SCOPE }, () => {
      const wf = getActiveWorkflow(db, wfKey);
      if (!wf) {
        const err = new NotFoundError(wfKey);
        err.message = `No active workflow ${wfKey}`;
        throw err;
      }
      return { item: view(wf) };
    }, opts);
    send(res, 200, body);
    return;
  }

  if (action === 'retire') {
    const client = requireAccess(db, { key, operation: 'retireWorkflow', params: { key: wfKey }, scope: WORKFLOWS_ADMIN_SCOPE });
    const body = await readJsonBody(req);
    const extra = Object.keys(body).filter((f) => f !== 'actor').map((f) => `${f} is not a field this endpoint accepts`);
    if (extra.length) throw new ValidationError(extra);
    send(res, 200, { item: view(retireWorkflow(db, wfKey, { actor: actorFor(body, client, db), ...opts })) });
    return;
  }

  const client = requireAccess(db, { key, operation: 'publishWorkflow', scope: WORKFLOWS_ADMIN_SCOPE });
  const body = await readJsonBody(req);
  const actor = actorFor(body, client, db);
  const { actor: _actor, ...definition } = body;
  try {
    const shapeProblems = unknownFields(body);
    if (shapeProblems.length) throw new ValidationError(shapeProblems);
    const wf = publishWorkflow(db, definition, { actor, ...opts });
    send(res, wf.unchanged ? 200 : 201, { item: view(getWorkflow(db, wf.id)), unchanged: wf.unchanged },
      wf.unchanged ? {} : { Location: `${WORKFLOWS_BASE}/${encodeURIComponent(wf.workflow_key)}` });
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    // The request was understood, but the workflow it describes is not one we can accept.
    send(res, 422, { error: 'invalid_workflow', message: 'The workflow was not saved: fix every problem listed and publish it again.', problems: err.problems });
  }
}
