// The HTTP API, using Node's built-in http module.
//
// Read-only work order feed (STORY-011) — needs scope work_orders:read:
//   GET  /api/v1/openapi.json              the contract (no key needed; contains no data)
//   GET  /api/v1/work-orders               list, a page at a time
//   GET  /api/v1/work-orders/changes       ?since=<ISO time>
//   GET  /api/v1/work-orders/search        ?q=<keywords>
//   GET  /api/v1/work-orders/{id}          one work order
//
// Locate tickets from the one-call centre (STORY-013) — needs scope locate_tickets:write:
//   GET   /api/v1/locate-tickets/{id}            view a ticket
//   PATCH /api/v1/locate-tickets/{id}            update: { actor, locator_notes?, marking_details?, work_order_id?, status? }
//   POST  /api/v1/locate-tickets/{id}/respond    respond: { actor, code, note? }
//   POST  /api/v1/locate-tickets/{id}/complete   complete: { actor }
//
// Every request is authenticated; refusals are audited. Errors are always JSON.

import { createServer } from 'node:http';
import {
  auditedRead, requireAccess, UnauthorizedError, ForbiddenError, AuditUnavailableError, LOCATE_TICKETS_SCOPE,
} from './clients.js';
import { listWorkOrders, workOrderChanges, searchWorkOrders, getPublicWorkOrder } from './workOrderFeed.js';
import { openApiDocument } from './openapi.js';
import { ValidationError, NotFoundError, ConflictError } from '../workOrders.js';
import {
  getLocateTicket, updateLocateTicket, respondToLocateTicket, completeLocateTicket, deliveryStatus,
} from '../locateTickets.js';

const BASE = '/api/v1';
const MAX_BODY_BYTES = 64 * 1024;

function send(res, status, body, headers = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(json);
}

/** The database itself is unreachable (closed, locked, busy, cannot open) — as opposed to a bug. */
export function isDatabaseUnavailable(err) {
  return err?.code === 'ERR_INVALID_STATE' || /SQLITE_(BUSY|LOCKED|CANTOPEN|IOERR)/.test(`${err?.errstr ?? ''} ${err?.message ?? ''}`);
}

function bearerKey(req) {
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
  return match ? match[1] : null;
}

/** Read a JSON object body, at most 64 KB. Anything else is a ValidationError (400). */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ValidationError([`request body must be at most ${MAX_BODY_BYTES} bytes`]);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ValidationError(['request body must be valid JSON']);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError(['request body must be a JSON object']);
  return body;
}

// ---------- work order feed (read-only) ----------

function workOrderRoute(pathname, query) {
  const params = Object.fromEntries(query);
  if (pathname === `${BASE}/work-orders`) return { operation: 'listWorkOrders', read: listWorkOrders, params };
  if (pathname === `${BASE}/work-orders/changes`) return { operation: 'workOrderChanges', read: workOrderChanges, params };
  if (pathname === `${BASE}/work-orders/search`) return { operation: 'searchWorkOrders', read: searchWorkOrders, params };
  const one = new RegExp(`^${BASE}/work-orders/([^/]+)$`).exec(pathname);
  if (one) return { operation: 'getWorkOrder', read: getPublicWorkOrder, params: { id: decodeURIComponent(one[1]) } };
  return null;
}

// ---------- locate tickets ----------

const TICKET_PATH = new RegExp(`^${BASE}/locate-tickets/([^/]+)(?:/(respond|complete))?$`);

/** The person acting, plus the system their request came through, e.g. "locator-1 via City app". */
function actingAs(body, client) {
  if (typeof body.actor !== 'string' || !body.actor.trim()) throw new ValidationError(['actor is required']);
  return `${body.actor.trim()} via ${client.name}`;
}

async function handleTicket(req, res, db, match, { now, bluestakes }) {
  const id = decodeURIComponent(match[1]);
  const action = match[2] ?? null;
  const allowed = action ? 'POST' : 'GET, PATCH';
  if (!allowed.split(', ').includes(req.method)) {
    send(res, 405, { error: 'method_not_allowed', message: `Use ${allowed} here` }, { Allow: allowed });
    return;
  }
  const opts = now ? { now } : {};
  const key = bearerKey(req);

  if (req.method === 'GET') {
    const body = auditedRead(db, { key, operation: 'getLocateTicket', params: { id }, scope: LOCATE_TICKETS_SCOPE },
      () => ({ item: getLocateTicket(db, id) }), opts);
    send(res, 200, { ...body, delivery: deliveryStatus(db, id) });
    return;
  }

  const operation = action ? `${action}LocateTicket` : 'updateLocateTicket';
  const client = requireAccess(db, { key, operation, params: { id }, scope: LOCATE_TICKETS_SCOPE });
  const body = await readJsonBody(req);
  const actor = actingAs(body, client);

  if (action === 'respond') {
    const result = await respondToLocateTicket(db, id, { code: body.code, note: body.note ?? null, actor, bluestakes, ...opts });
    const { delivery, delivery_failures: failures, ...item } = result;
    send(res, 200, { item, delivery, delivery_failures: failures });
  } else if (action === 'complete') {
    send(res, 200, { item: completeLocateTicket(db, id, { actor, ...opts }) });
  } else {
    const { actor: _actor, ...changes } = body;
    send(res, 200, { item: updateLocateTicket(db, id, changes, { actor, ...opts }) });
  }
}

// ---------- server ----------

/**
 * `bluestakes` is the one-call centre client used to deliver ticket responses (see server/bluestakes.js).
 * Without it, responses are saved and stay pending delivery.
 */
export function createApiServer(db, { now, bluestakes = null, requestTimeoutMs = 10_000 } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      const ticket = TICKET_PATH.exec(url.pathname);
      if (ticket) {
        await handleTicket(req, res, db, ticket, { now, bluestakes });
        return;
      }
      if (req.method !== 'GET') {
        send(res, 405, { error: 'method_not_allowed', message: 'Work order endpoints are read-only: use GET' }, { Allow: 'GET' });
        return;
      }
      if (url.pathname === `${BASE}/openapi.json`) {
        send(res, 200, openApiDocument());
        return;
      }
      const match = workOrderRoute(url.pathname, url.searchParams);
      if (!match) {
        send(res, 404, { error: 'not_found', message: `No endpoint at ${url.pathname}` });
        return;
      }
      const body = auditedRead(db, { key: bearerKey(req), operation: match.operation, params: match.params },
        () => match.read(db, match.params), now ? { now } : {});
      send(res, 200, body);
    } catch (err) {
      if (err instanceof ForbiddenError) send(res, 403, { error: 'forbidden', message: err.message });
      else if (err instanceof UnauthorizedError) send(res, 401, { error: 'unauthorized', message: err.message }, { 'WWW-Authenticate': 'Bearer' });
      else if (err instanceof ValidationError) send(res, 400, { error: 'invalid_request', message: err.message, problems: err.problems });
      else if (err instanceof NotFoundError) send(res, 404, { error: 'not_found', message: err.message });
      else if (err instanceof ConflictError) send(res, 409, { error: 'conflict', message: err.message });
      else if (err instanceof AuditUnavailableError) send(res, 503, { error: 'audit_unavailable', message: err.message }, { 'Retry-After': '30' });
      else if (isDatabaseUnavailable(err)) {
        console.error('API: database unavailable', err);
        send(res, 503, { error: 'database_unavailable', message: 'The work order database cannot be reached. Try again later.' }, { 'Retry-After': '30' });
      } else {
        console.error('API: unexpected error', err);
        send(res, 500, { error: 'internal_error', message: 'Something went wrong on our side.' });
      }
    }
  });
  server.requestTimeout = requestTimeoutMs; // a stuck request is dropped rather than held forever
  server.headersTimeout = requestTimeoutMs;
  return server;
}
