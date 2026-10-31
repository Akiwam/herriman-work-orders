// Work order writes for outside systems (STORY-004). Needs scope work_orders:write.
//
//   POST  /api/v1/work-orders                 create   — optional Idempotency-Key header
//   PATCH /api/v1/work-orders/{id}            update   — If-Match: "v<version>" required
//   POST  /api/v1/work-orders/{id}/complete   complete — If-Match: "v<version>" required
//   POST  /api/v1/work-orders/{id}/transition move to the next workflow step — If-Match required (STORY-006)
//
// Every body is checked against the published contract (unknown fields are refused). Every response
// carries the work order in the published format (checked before it is sent) and an ETag with its
// version. A stale If-Match gets 412 with the current work order, so the caller can re-read and retry.
// The actual changes go through createWorkOrder / updateWorkOrder / completeWorkOrder, so they are
// audited (as "<actor> via <system>") and pushed to GIS like any other change.

import { send, readJsonBody } from './http.js';
import { requireAccess, WORK_ORDERS_WRITE_SCOPE } from './clients.js';
import { toPublic, validateResponse, SCHEMA_VERSION } from './workOrderFeed.js';
import {
  createWorkOrder, updateWorkOrder, completeWorkOrder, getWorkOrder, ValidationError, NotFoundError, VersionConflictError,
} from '../workOrders.js';
import { transitionWorkOrder, workflowPosition } from '../workflows.js';

const BASE = '/api/v1/work-orders';
const ONE = new RegExp(`^${BASE}/([^/]+)(?:/(complete|transition))?$`);

// What each body may contain. A trailing ? means optional. Also the source of the OpenAPI request
// bodies (openapi.js), so the published contract and the real checks are the same list.
export const BODIES = {
  create: { actor: 'string', title: 'string', description: 'string?', work_type: 'string?', priority: 'string?', location_text: 'string?', asset_ids: 'array?' },
  update: { actor: 'string', title: 'string?', description: 'string?', work_type: 'string?', priority: 'string?', location_text: 'string?' },
  complete: { actor: 'string', note: 'string' },
  transition: { actor: 'string', to: 'string' },
};

/** The If-Match header was not sent, but this change needs it (HTTP 428). */
export class PreconditionRequiredError extends Error {
  constructor() {
    super('This change needs an If-Match header with the version you last read, e.g. If-Match: "v3". Read the work order first.');
    this.name = 'PreconditionRequiredError';
  }
}

/** Our own response did not match the published format. Should never happen; refuse rather than send it. */
export class ResponseFormatError extends Error {
  constructor(problems) {
    super(`Response did not match the published format: ${problems.join('; ')}`);
    this.name = 'ResponseFormatError';
  }
}

export const etagFor = (version) => `"v${version}"`;

function parseIfMatch(header) {
  if (header === undefined || header === '') throw new PreconditionRequiredError();
  const match = /^(?:W\/)?"v(\d+)"$/.exec(String(header).trim());
  if (!match) throw new ValidationError(['If-Match must look like "v3" — the ETag from your last read']);
  return Number(match[1]);
}

/** Refuse unknown fields, missing required fields and wrong types — the contract is the specification. */
function checkBody(body, spec) {
  const problems = [];
  for (const field of Object.keys(body)) if (!(field in spec)) problems.push(`${field} is not a field this endpoint accepts`);
  for (const [field, type] of Object.entries(spec)) {
    const optional = type.endsWith('?');
    const base = optional ? type.slice(0, -1) : type;
    const value = body[field];
    if (value === undefined || value === null) {
      if (!optional) problems.push(`${field} is required`);
    } else if (base === 'array' ? !(Array.isArray(value) && value.every((v) => typeof v === 'string')) : typeof value !== base) {
      problems.push(base === 'array' ? `${field} must be a list of text values` : `${field} must be ${base === 'string' ? 'text' : base}`);
    }
  }
  if (problems.length) throw new ValidationError(problems);
}

/** Send one work order in the published format, after checking it really is in that format. */
function sendWorkOrder(res, db, status, id, extra = {}, headers = {}) {
  const row = getWorkOrder(db, id);
  const body = { schema_version: SCHEMA_VERSION, item: toPublic(db, row) };
  const problems = validateResponse(body);
  if (problems.length) throw new ResponseFormatError(problems);
  // The workflow position is in meta, not the work order, so the published work order format is unchanged.
  const meta = { ...extra.meta, workflow: workflowPosition(db, row) };
  send(res, status, { ...body, ...extra, meta }, { ETag: etagFor(row.version), ...headers });
}

export function isWorkOrderWrite(req, pathname) {
  if (pathname === BASE) return req.method === 'POST';
  const m = ONE.exec(pathname);
  if (!m || ['changes', 'search'].includes(m[1])) return false;
  return m[2] ? req.method === 'POST' : req.method === 'PATCH';
}

export async function handleWorkOrderWrite(req, res, db, pathname, { key, gis = null, now } = {}) {
  const m = ONE.exec(pathname);
  const id = m ? decodeURIComponent(m[1]) : null;
  const action = pathname === BASE ? 'create' : (m[2] ?? 'update');
  const operation = `${action}WorkOrder`;
  const opts = now ? { now } : {};

  const client = requireAccess(db, { key, operation, params: id ? { id } : {}, scope: WORK_ORDERS_WRITE_SCOPE });
  const body = await readJsonBody(req);
  checkBody(body, BODIES[action]);
  const actor = `${body.actor.trim()} via ${client.name}`;
  const { actor: _actor, ...fields } = body;

  if (action === 'create') {
    const idemKey = req.headers['idempotency-key'];
    if (idemKey !== undefined && !/^[\x21-\x7e]{1,200}$/.test(idemKey)) throw new ValidationError(['Idempotency-Key must be 1–200 visible characters']);
    const created = await createWorkOrder(db, {
      ...fields,
      created_by: actor,
      // Scoped to the calling system, so two systems can never collide on the same key.
      request_id: idemKey ? `api:${client.id}:${idemKey}` : undefined,
    }, { gis, ...opts });
    sendWorkOrder(res, db, created.duplicate ? 200 : 201, created.id, { meta: { gis_sync: created.gis_sync } },
      created.duplicate ? { 'Idempotent-Replayed': 'true' } : { Location: `${BASE}/${created.id}` });
    return;
  }

  if (!getWorkOrder(db, id)) throw new NotFoundError(id);
  const expectedVersion = parseIfMatch(req.headers['if-match']);
  try {
    if (action === 'transition') {
      transitionWorkOrder(db, id, { to: fields.to, actor, expectedVersion, ...opts });
      sendWorkOrder(res, db, 200, id);
      return;
    }
    const result = action === 'complete'
      ? await completeWorkOrder(db, id, { note: fields.note, actor, gis, expectedVersion, ...opts })
      : await updateWorkOrder(db, id, fields, { actor, gis, expectedVersion, ...opts });
    sendWorkOrder(res, db, 200, id, { meta: { gis_sync: result.gis_sync } });
  } catch (err) {
    if (!(err instanceof VersionConflictError)) throw err;
    // Stale copy: say so, and hand back the current work order so the caller can re-read and retry.
    res.errorCode = 'precondition_failed';
    const row = getWorkOrder(db, id);
    send(res, 412, {
      error: 'precondition_failed', message: err.message, current: { schema_version: SCHEMA_VERSION, item: toPublic(db, row) },
    }, { ETag: etagFor(row.version) });
  }
}
