// Citizen requests from the public site (STORY-003, REQ-037).
//
// A submission becomes a service request plus a work order in the normal system (created by
// 'public-portal' through createWorkOrder, so it is audited like any other). The citizen gets a
// tracking code. Every submission attempt — accepted, duplicate or rejected — is written to
// public_submission_log with its IP address and time.
//
// New requests are NOT public: staff decide whether a work order is published.

import { randomInt, randomUUID } from 'node:crypto';
import { inTransaction } from './db.js';
import { createWorkOrder, getWorkOrder, writeAudit, ValidationError, NotFoundError } from './workOrders.js';

export const PORTAL_ACTOR = 'public-portal';
const defaultNow = () => new Date().toISOString();

// Letters and digits that cannot be confused when read aloud or typed (no 0/O, 1/I/L).
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function newTrackingCode() {
  let code = 'HWO-';
  for (let i = 0; i < 6; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

const LIMITS = { description: [10, 2000], location_text: [3, 300], category: [2, 50], contact: [3, 200], submission_id: [8, 100] };

function text(v) {
  return typeof v === 'string' ? v.trim() : v;
}

/** Problems with a submission; an empty list means it can be accepted. */
export function validateSubmission(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return ['the request must be an object'];
  const problems = [];
  const check = (field, required) => {
    const v = text(input[field]);
    if (v === undefined || v === null || v === '') {
      if (required) problems.push(`${field} is required`);
      return;
    }
    const [min, max] = LIMITS[field];
    if (typeof v !== 'string') problems.push(`${field} must be text`);
    else if (v.length < min || v.length > max) problems.push(`${field} must be ${min} to ${max} characters`);
  };
  check('description', true);
  check('location_text', true);
  check('category', false);
  check('contact', false);
  check('submission_id', false);
  for (const [field, lo, hi] of [['latitude', -90, 90], ['longitude', -180, 180]]) {
    const v = input[field];
    if (v !== undefined && v !== null && !(typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi)) {
      problems.push(`${field} must be a number from ${lo} to ${hi}`);
    }
  }
  return problems;
}

/** Too many submissions from one address in a short time (HTTP 429). */
export class RateLimitedError extends Error {
  constructor(retryAfterSeconds) {
    super('Too many requests from this address. Please try again later.');
    this.name = 'RateLimitedError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// Spam protection: at most this many accepted submissions per address per window.
export const RATE_LIMIT = { max: 5, windowMinutes: 60 };

function logSubmission(db, { ip, at, outcome, serviceRequestId = null, detail = null }) {
  db.prepare(`INSERT INTO public_submission_log (ip_address, submitted_at, outcome, service_request_id, detail)
              VALUES (?, ?, ?, ?, ?)`).run(ip, at, outcome, serviceRequestId, detail);
}

/** Log a submission that was refused before it could be read (e.g. the body was not valid JSON). */
export function logUnreadableSubmission(db, { ip, detail, now = defaultNow }) {
  logSubmission(db, { ip, at: now(), outcome: 'rejected', detail });
}

/** What the citizen gets back. Nothing internal: no work order id, no contact, no IP. */
function receipt(row, duplicate) {
  return { tracking_code: row.tracking_code, status: 'received', submitted_at: row.submitted_at, duplicate };
}

/**
 * Accept a citizen's request. `ip` is the address it came from (required: the caller must pass it).
 *
 * - Invalid: logged as 'rejected' with the problems, ValidationError thrown, nothing else saved.
 * - Same submission_id again (a double-click or retry): logged as 'duplicate', the original receipt returned.
 * - Valid: a work order is created (audited, actor public-portal), then the service request is saved
 *   and logged as 'accepted'. If saving the request fails after the work order was made, sending the
 *   same submission again finishes the job without a second work order (the work order's request_id
 *   is derived from the submission_id).
 */
export async function submitPublicRequest(db, input, { ip, gis = null, now = defaultNow, rateLimit = RATE_LIMIT } = {}) {
  if (typeof ip !== 'string' || ip.trim() === '') throw new TypeError('submitPublicRequest needs the submitter\'s IP address');
  const at = now();

  const windowStart = new Date(Date.parse(at) - rateLimit.windowMinutes * 60 * 1000).toISOString();
  const recent = db.prepare(`SELECT COUNT(*) AS n FROM public_submission_log
                             WHERE ip_address = ? AND outcome = 'accepted' AND submitted_at > ?`).get(ip, windowStart).n;
  if (recent >= rateLimit.max) {
    logSubmission(db, { ip, at, outcome: 'rate_limited', detail: `${recent} accepted in the last ${rateLimit.windowMinutes} minutes` });
    throw new RateLimitedError(rateLimit.windowMinutes * 60);
  }

  const problems = validateSubmission(input);
  if (problems.length) {
    logSubmission(db, { ip, at, outcome: 'rejected', detail: problems.join('; ') });
    throw new ValidationError(problems);
  }

  const submissionId = text(input.submission_id) || randomUUID();
  const existing = db.prepare('SELECT * FROM service_requests WHERE submission_id = ?').get(submissionId);
  if (existing) {
    logSubmission(db, { ip, at, outcome: 'duplicate', serviceRequestId: existing.id });
    return receipt(existing, true);
  }

  const description = text(input.description);
  const category = text(input.category) || 'citizen_request';
  const location = text(input.location_text);

  const workOrder = await createWorkOrder(db, {
    request_id: `public:${submissionId}`,
    title: description.length > 80 ? `${description.slice(0, 77)}…` : description,
    description,
    work_type: category,
    location_text: location,
    created_by: PORTAL_ACTOR,
  }, { gis, now });

  return inTransaction(db, () => {
    const raced = db.prepare('SELECT * FROM service_requests WHERE submission_id = ?').get(submissionId);
    if (raced) {
      logSubmission(db, { ip, at, outcome: 'duplicate', serviceRequestId: raced.id });
      return receipt(raced, true);
    }
    let code = newTrackingCode();
    while (db.prepare('SELECT 1 FROM service_requests WHERE tracking_code = ?').get(code)) code = newTrackingCode();
    const row = {
      id: randomUUID(),
      tracking_code: code,
      submission_id: submissionId,
      description,
      category,
      location_text: location,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      contact: text(input.contact) || null,
      work_order_id: workOrder.id,
      submitted_at: at,
    };
    db.prepare(`INSERT INTO service_requests (id, tracking_code, submission_id, description, category, location_text,
                latitude, longitude, contact, work_order_id, submitted_at)
                VALUES (:id, :tracking_code, :submission_id, :description, :category, :location_text,
                :latitude, :longitude, :contact, :work_order_id, :submitted_at)`).run(row);
    logSubmission(db, { ip, at, outcome: 'accepted', serviceRequestId: row.id });
    return receipt(row, false);
  });
}

// ---------- publishing (staff) ----------

/** Staff show a work order on the public site, or take it down again. Audited. */
export function publishWorkOrder(db, id, { actor, isPublic = true, now = defaultNow } = {}) {
  if (typeof actor !== 'string' || !actor.trim()) throw new ValidationError(['actor is required']);
  return inTransaction(db, () => {
    const before = getWorkOrder(db, id);
    if (!before) throw new NotFoundError(id);
    const value = isPublic ? 1 : 0;
    if (before.is_public === value) return before;
    const at = now();
    db.prepare('UPDATE work_orders SET is_public = ? WHERE id = ?').run(value, id);
    const after = getWorkOrder(db, id);
    writeAudit(db, { entityType: 'work_order', entityId: id, action: isPublic ? 'publish' : 'unpublish', actor: actor.trim(), before, after, at });
    return after;
  });
}

// ---------- the public view ----------

/** Asked for something the public may not see. Deliberately the same message as "does not exist". */
export class PublicNotFoundError extends NotFoundError {
  constructor() {
    super('');
    this.name = 'PublicNotFoundError';
    this.message = 'No public work order or request was found with that reference.';
  }
}

const STATUS_LABELS = { open: 'Open', completed: 'Completed' };

// Audit actions shown to the public, in plain words. Anything not listed (publish, unpublish, …)
// is internal and is left out of the history.
const HISTORY_LABELS = {
  create: 'Request received',
  update: 'Work order updated',
  gis_update: 'Location details updated',
  complete: 'Work completed',
};

/**
 * The public view of one work order: what it is, its current status, and a dated history.
 * Never includes who did what, internal notes, before/after values, contact details or IPs.
 */
function publicView(db, wo, trackingCode = null) {
  const history = db.prepare("SELECT action, occurred_at FROM audit_entries WHERE entity_type = 'work_order' AND entity_id = ? ORDER BY id")
    .all(wo.id)
    .filter((a) => Object.hasOwn(HISTORY_LABELS, a.action))
    .map((a) => ({ at: a.occurred_at, event: HISTORY_LABELS[a.action] }));
  return {
    reference: trackingCode,
    title: wo.title,
    category: wo.work_type,
    status: STATUS_LABELS[wo.status] ?? wo.status,
    location: wo.address ?? wo.location_text,
    reported_at: wo.created_at,
    last_updated_at: wo.updated_at,
    completed_at: wo.completed_at,
    history,
  };
}

/**
 * Look up what the public may see.
 *   { trackingCode } — a citizen's own request, published or not (they hold the code).
 *   { workOrderId }  — only if staff have published it.
 * Anything else, including a real but unpublished work order, throws PublicNotFoundError.
 */
export function getPublicView(db, { trackingCode, workOrderId } = {}) {
  if (typeof trackingCode === 'string' && trackingCode.trim()) {
    const req = db.prepare('SELECT * FROM service_requests WHERE tracking_code = ?').get(trackingCode.trim().toUpperCase());
    if (!req) throw new PublicNotFoundError();
    return publicView(db, getWorkOrder(db, req.work_order_id), req.tracking_code);
  }
  if (typeof workOrderId === 'string' && workOrderId.trim()) {
    const wo = getWorkOrder(db, workOrderId.trim());
    if (!wo || wo.is_public !== 1) throw new PublicNotFoundError();
    const req = db.prepare('SELECT tracking_code FROM service_requests WHERE work_order_id = ?').get(wo.id);
    return { id: wo.id, ...publicView(db, wo, req?.tracking_code ?? null) };
  }
  throw new ValidationError(['a tracking code or work order id is required']);
}

/** Recently updated published work orders, for the public activity page. */
export function listPublicWorkOrders(db, { limit = 20 } = {}) {
  const n = Number(limit);
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new ValidationError(['limit must be a whole number from 1 to 100']);
  return db.prepare('SELECT * FROM work_orders WHERE is_public = 1 ORDER BY updated_at DESC, id LIMIT ?').all(n)
    .map((wo) => ({ id: wo.id, ...publicView(db, wo) }))
    .map(({ reference: _r, ...item }) => item); // tracking codes are the citizen's, not shown in a public list
}

// ---------- IP retention ----------

// PLACEHOLDER: 90 days until the city's records retention rule for submission IPs is known.
export const IP_RETENTION_DAYS = 90;

/**
 * Remove IP addresses older than the retention period from the submission log. The log rows stay
 * (time and outcome), only the IP is cleared. Safe to run any number of times. Returns how many were cleared.
 */
export function purgeSubmissionIps(db, { now = defaultNow, retentionDays = IP_RETENTION_DAYS } = {}) {
  const cutoff = new Date(Date.parse(now()) - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  return Number(db.prepare('UPDATE public_submission_log SET ip_address = NULL WHERE ip_address IS NOT NULL AND submitted_at < ?')
    .run(cutoff).changes);
}
