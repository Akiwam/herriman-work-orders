// Operational readiness over HTTP (STORY-010, REQ-052, REQ-053). All need readiness:review.
//
//   GET  /api/v1/readiness                    the checklist: manual items as recorded, and the automatic checks
//   PUT  /api/v1/readiness/items/{key}        record a manual item: { status?, note?, due_on? }   (personal key)
//   POST /api/v1/readiness/assessments        run an assessment; optional Idempotency-Key header (personal key)
//   GET  /api/v1/readiness/assessments        every assessment, newest first
//   GET  /api/v1/readiness/assessments/{id}   one assessment with every result
//
// Recording items and running assessments need a person's own key, so every record names a verified
// reviewer. `connections` is how the server was started — whether GIS and Blue Stakes are the real
// services or stand-ins — and is what the assessment checks against.

import { send, readJsonBody } from './http.js';
import { requirePerson, auditedRead } from './clients.js';
import { NotFoundError } from '../workOrders.js';
import {
  listManualItems, recordItem, runAssessment, listAssessments, getAssessment, AUTOMATIC_CHECKS, READINESS_REVIEW, TARGET_DATE,
} from '../readiness.js';

export const READINESS_BASE = '/api/v1/readiness';
export const ITEM_FIELDS = ['status', 'note', 'due_on'];
const ITEM = new RegExp(`^${READINESS_BASE}/items/([^/]+)$`);
const ASSESSMENT = new RegExp(`^${READINESS_BASE}/assessments(?:/([^/]+))?$`);

function methodNotAllowed(res, allowed) {
  send(res, 405, { error: 'method_not_allowed', message: `Use ${allowed} here` }, { Allow: allowed });
}

export async function handleReadiness(req, res, db, url, { key, now, connections = {} } = {}) {
  const opts = now ? { now } : {};

  if (url.pathname === READINESS_BASE) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    send(res, 200, auditedRead(db, { key, operation: 'readinessChecklist', scope: READINESS_REVIEW }, () => ({
      target_date: TARGET_DATE,
      manual_items: listManualItems(db),
      automatic_checks: Object.entries(AUTOMATIC_CHECKS).map(([k, c]) => ({ key: k, category: c.category, title: c.title })),
    }), opts));
    return;
  }

  const item = ITEM.exec(url.pathname);
  if (item) {
    if (req.method !== 'PUT') return methodNotAllowed(res, 'PUT');
    const itemKey = decodeURIComponent(item[1]);
    const reviewer = requirePerson(db, { key, operation: 'recordReadinessItem', params: { key: itemKey }, scope: READINESS_REVIEW });
    const body = await readJsonBody(req);
    const { item: recorded, changed } = recordItem(db, itemKey, body, { actorUserId: reviewer.user_id, ...opts });
    send(res, 200, { item: recorded, changed });
    return;
  }

  const assessment = ASSESSMENT.exec(url.pathname);
  if (!assessment) {
    send(res, 404, { error: 'not_found', message: `No endpoint at ${url.pathname}` });
    return;
  }
  const id = assessment[1] ? decodeURIComponent(assessment[1]) : null;
  if (id) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    send(res, 200, auditedRead(db, { key, operation: 'getReadinessAssessment', params: { id }, scope: READINESS_REVIEW }, () => {
      const found = getAssessment(db, id);
      if (!found) throw Object.assign(new NotFoundError(id), { message: `No readiness assessment ${id}` });
      return { item: found };
    }, opts));
    return;
  }
  if (req.method === 'GET') {
    send(res, 200, auditedRead(db, { key, operation: 'listReadinessAssessments', scope: READINESS_REVIEW }, () => ({ items: listAssessments(db) }), opts));
    return;
  }
  if (req.method !== 'POST') return methodNotAllowed(res, 'GET, POST');
  const reviewer = requirePerson(db, { key, operation: 'runReadinessAssessment', scope: READINESS_REVIEW });
  const requestId = req.headers['idempotency-key'];
  const result = await runAssessment(db, { actorUserId: reviewer.user_id, requestId, connections, ...opts });
  const { duplicate, ...record } = result;
  send(res, duplicate ? 200 : 201, { item: record }, duplicate ? { 'Idempotent-Replayed': 'true' } : { Location: `${READINESS_BASE}/assessments/${record.id}` });
}
