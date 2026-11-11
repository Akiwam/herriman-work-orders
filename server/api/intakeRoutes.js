// AI-first intake over HTTP (STORY-015). Reading needs work_orders:read; deciding needs intake:approve
// with a person's own key or console session, so every decision names a verified person.
//
//   GET  /api/v1/intake/drafts                   the queue (?status=proposed|approved|rejected|superseded)
//   GET  /api/v1/intake/drafts/{id}              one draft with its source; its version is the ETag
//   POST /api/v1/intake/drafts/{id}/approve      { changes? } — If-Match required
//   POST /api/v1/intake/drafts/{id}/correct      { changes }  — If-Match required
//   POST /api/v1/intake/drafts/{id}/reject       { reason }   — If-Match required
//   POST /api/v1/intake/drafts/{id}/redraft      the agent drafts again from the source as it is now
//
// A stale If-Match gets 412 with the current draft. Already decided, superseded or a changed source
// gets 409 with a code saying which.

import { send, readJsonBody } from './http.js';
import { requirePerson, auditedRead } from './clients.js';
import { ValidationError, NotFoundError } from '../workOrders.js';
import {
  listDrafts, getDraft, approveDraft, correctDraft, rejectDraft, proposeDraft, INTAKE_APPROVE, REQUIRED_TO_APPROVE, DRAFT_FIELDS,
} from '../intake.js';

export const INTAKE_BASE = '/api/v1/intake/drafts';
const ONE = new RegExp(`^${INTAKE_BASE}/([^/]+)(?:/(approve|correct|reject|redraft))?$`);
const STATUSES = ['proposed', 'approved', 'rejected', 'superseded'];
const CODES = { DraftAlreadyDecided: 'already_decided', DraftSuperseded: 'superseded', SourceChanged: 'source_changed' };

export const isIntakePath = (pathname) => pathname === INTAKE_BASE || ONE.test(pathname);

const roleName = (db, roleId) => db.prepare('SELECT name FROM roles WHERE id = ?').get(roleId)?.name ?? roleId;
const userName = (db, id) => (id ? db.prepare('SELECT display_name FROM users WHERE id = ?').get(id)?.display_name ?? id : null);

/** The roles whose holders may approve: anyone with intake:approve. */
function whoCanApprove(db) {
  return db.prepare('SELECT name, permissions_json FROM roles ORDER BY is_builtin DESC, name').all()
    .filter((r) => JSON.parse(r.permissions_json).includes(INTAKE_APPROVE)).map((r) => r.name);
}

/** What the reviewer sees of the source. Never the citizen's contact details. */
function sourceSummary(db, draft) {
  if (draft.source_type === 'citizen_request') {
    const r = db.prepare('SELECT tracking_code, description, category, location_text, submitted_at FROM service_requests WHERE id = ?').get(draft.source_id);
    return { kind: 'Citizen request', reference: r.tracking_code, text: r.description, category: r.category, location: r.location_text, received_at: r.submitted_at };
  }
  const t = db.prepare('SELECT ticket_number, ticket_type, excavator_name, work_description, dig_address, received_at, due_at FROM locate_tickets WHERE id = ?').get(draft.source_id);
  return { kind: 'Blue Stakes ticket', reference: t.ticket_number, text: `${t.excavator_name}: ${t.work_description}`, category: t.ticket_type, location: t.dig_address, received_at: t.received_at, due_at: t.due_at };
}

/** A draft as the console shows it: who performs the work, who must approve it, and who did. */
function present(db, draft, canApprove) {
  const final = draft.final ?? draft.proposed;
  return {
    ...draft,
    source: sourceSummary(db, draft),
    performer_label: roleName(db, draft.performer),
    approver_label: roleName(db, draft.approver),
    who_can_approve: canApprove,
    reviewed_by_name: userName(db, draft.reviewed_by),
    missing: REQUIRED_TO_APPROVE.filter((f) => typeof final[f] !== 'string' || !final[f].trim()),
  };
}

function onlyFields(body, allowed) {
  const extra = Object.keys(body).filter((f) => !allowed.includes(f));
  if (extra.length) throw new ValidationError(extra.map((f) => `${f} is not a field this endpoint accepts`));
}

function ifMatch(req) {
  const header = req.headers['if-match'];
  if (header === undefined || header === '') return null;
  const m = /^(?:W\/)?"v(\d+)"$/.exec(String(header).trim());
  if (!m) throw new ValidationError(['If-Match must look like "v2" — the ETag from your last read']);
  return Number(m[1]);
}

export async function handleIntake(req, res, db, url, { key, now } = {}) {
  const opts = now ? { now } : {};
  if (url.pathname === INTAKE_BASE) {
    if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed', message: 'Use GET here' }, { Allow: 'GET' });
    const status = url.searchParams.get('status') ?? 'proposed';
    if (!STATUSES.includes(status)) throw new ValidationError([`status must be one of ${STATUSES.join(', ')}`]);
    const canApprove = whoCanApprove(db);
    return send(res, 200, auditedRead(db, { key, operation: 'intakeQueue', params: { status } },
      () => ({ items: listDrafts(db, { status }).map((d) => present(db, d, canApprove)) }), opts));
  }

  const [, rawId, action] = ONE.exec(url.pathname);
  const id = decodeURIComponent(rawId);
  if (!action) {
    if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed', message: 'Use GET here' }, { Allow: 'GET' });
    const body = auditedRead(db, { key, operation: 'intakeDraft', params: { id } }, () => {
      const draft = getDraft(db, id);
      if (!draft) throw Object.assign(new NotFoundError(id), { message: `No intake draft ${id}` });
      return { item: present(db, draft, whoCanApprove(db)), fields: DRAFT_FIELDS, required: REQUIRED_TO_APPROVE };
    }, opts);
    return send(res, 200, body, { ETag: `"v${body.item.version}"` });
  }

  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed', message: 'Use POST here' }, { Allow: 'POST' });
  const person = requirePerson(db, { key, operation: `intake_${action}`, params: { id }, scope: INTAKE_APPROVE });
  const body = await readJsonBody(req);
  const current = getDraft(db, id);
  if (!current) throw Object.assign(new NotFoundError(id), { message: `No intake draft ${id}` });

  if (action === 'redraft') {
    onlyFields(body, []);
    const draft = await proposeDraft(db, { sourceType: current.source_type, sourceId: current.source_id }, opts);
    return send(res, draft.duplicate ? 200 : 201, { item: present(db, getDraft(db, draft.id), whoCanApprove(db)), duplicate: draft.duplicate });
  }

  const expectedVersion = ifMatch(req);
  if (expectedVersion === null) {
    return send(res, 428, { error: 'precondition_required', message: 'Send If-Match with the version you are looking at, e.g. If-Match: "v1". Open the draft first.' });
  }
  const as = { actorUserId: person.user_id, expectedVersion, ...opts };
  try {
    if (action === 'approve') {
      onlyFields(body, ['changes']);
      const { draft, workOrder, duplicate } = await approveDraft(db, id, { ...as, changes: body.changes ?? {} });
      return send(res, duplicate ? 200 : 201, { item: present(db, draft, whoCanApprove(db)), work_order_id: workOrder.id, duplicate });
    }
    if (action === 'correct') {
      onlyFields(body, ['changes']);
      return send(res, 200, { item: present(db, correctDraft(db, id, { ...as, changes: body.changes ?? {} }), whoCanApprove(db)) });
    }
    onlyFields(body, ['reason']);
    return send(res, 200, { item: present(db, rejectDraft(db, id, { ...as, reason: body.reason }), whoCanApprove(db)) });
  } catch (err) {
    if (err.name === 'DraftVersionConflict') {
      const latest = getDraft(db, id);
      return send(res, 412, { error: 'precondition_failed', message: err.message, current: present(db, latest, whoCanApprove(db)) }, { ETag: `"v${latest.version}"` });
    }
    if (CODES[err.name]) return send(res, 409, { error: CODES[err.name], message: err.message });
    throw err;
  }
}
