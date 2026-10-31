// The HTTP API, using Node's built-in http module.
//
// Read-only work order feed (STORY-011) — needs scope work_orders:read:
//   GET  /api/v1/openapi.json              the contract (no key needed; contains no data)
//   GET  /api/v1/work-orders               list, a page at a time
//   GET  /api/v1/work-orders/changes       ?since=<ISO time>
//   GET  /api/v1/work-orders/search        ?q=<keywords>
//   GET  /api/v1/work-orders/{id}          one work order
//   GET  /api/v1/work-orders/{id}/workflow its workflow step and where it can go next (STORY-006)
//
// Workflows (STORY-006) — see workflowRoutes.js; transitions are in workOrderWrites.js.
//
// Locate tickets from the one-call centre (STORY-013) — needs scope locate_tickets:write:
//   GET   /api/v1/locate-tickets/{id}            view a ticket
//   PATCH /api/v1/locate-tickets/{id}            update: { actor, locator_notes?, marking_details?, work_order_id?, status? }
//   POST  /api/v1/locate-tickets/{id}/respond    respond: { actor, code, note? }
//   POST  /api/v1/locate-tickets/{id}/complete   complete: { actor }
//
// Public site (STORY-003) — no key; see publicRoutes.js:
//   POST /api/v1/public/requests, GET /api/v1/public/requests/{code},
//   GET  /api/v1/public/work-orders, GET /api/v1/public/work-orders/{id}
//
// Every keyed request is authenticated; refusals are audited. Errors are always JSON.

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
import { send, readJsonBody, isDatabaseUnavailable, clientIp } from './http.js';
import { RateLimitedError } from '../publicRequests.js';
import { handlePublic, PUBLIC_BASE, isPagePath, servePage } from './publicRoutes.js';
import { startRequestLog } from './requestLog.js';
import {
  isWorkOrderWrite, handleWorkOrderWrite, etagFor, PreconditionRequiredError, ResponseFormatError,
} from './workOrderWrites.js';
import { getWorkOrder } from '../workOrders.js';
import { handleVendor, VENDOR_BASE } from './vendorRoutes.js';
import { handleHeatMap, HEAT_MAP_PATH } from './heatMapRoutes.js';
import { MapGenerationError } from '../heatMaps.js';
import { handleWorkflows, WORKFLOWS_BASE } from './workflowRoutes.js';
import { workflowPosition } from '../workflows.js';

const BASE = '/api/v1';

export { isDatabaseUnavailable };

function bearerKey(req) {
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
  return match ? match[1] : null;
}

// ---------- work order feed (read-only) ----------

function workOrderRoute(pathname, query) {
  const params = Object.fromEntries(query);
  if (pathname === `${BASE}/work-orders`) return { operation: 'listWorkOrders', read: listWorkOrders, params };
  if (pathname === `${BASE}/work-orders/changes`) return { operation: 'workOrderChanges', read: workOrderChanges, params };
  if (pathname === `${BASE}/work-orders/search`) return { operation: 'searchWorkOrders', read: searchWorkOrders, params };
  const position = new RegExp(`^${BASE}/work-orders/([^/]+)/workflow$`).exec(pathname);
  if (position) return { operation: 'getWorkOrderWorkflow', read: readWorkflowPosition, params: { id: decodeURIComponent(position[1]) } };
  const one = new RegExp(`^${BASE}/work-orders/([^/]+)$`).exec(pathname);
  if (one) return { operation: 'getWorkOrder', read: getPublicWorkOrder, params: { id: decodeURIComponent(one[1]) } };
  return null;
}

function readWorkflowPosition(db, { id }) {
  const wo = getWorkOrder(db, id);
  if (!wo) throw new NotFoundError(id);
  return { item: { work_order_id: wo.id, status: wo.status, ...workflowPosition(db, wo) } };
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
export function createApiServer(db, { now, bluestakes = null, gis = null, requestTimeoutMs = 10_000, trustProxy = false } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    startRequestLog(db, req, res, url, { ip: clientIp(req, { trustProxy }), ...(now ? { now } : {}) });
    try {
      if (isPagePath(url.pathname)) {
        servePage(req, res, url.pathname);
        return;
      }
      if (url.pathname.startsWith(`${PUBLIC_BASE}/`)) {
        await handlePublic(req, res, db, url, { now, ip: clientIp(req, { trustProxy }) });
        return;
      }
      const ticket = TICKET_PATH.exec(url.pathname);
      if (ticket) {
        await handleTicket(req, res, db, ticket, { now, bluestakes });
        return;
      }
      if (url.pathname === HEAT_MAP_PATH) {
        handleHeatMap(req, res, db, url, { key: bearerKey(req), now });
        return;
      }
      if (url.pathname.startsWith(`${VENDOR_BASE}/`)) {
        await handleVendor(req, res, db, url, { key: bearerKey(req), now });
        return;
      }
      if (url.pathname === WORKFLOWS_BASE || url.pathname.startsWith(`${WORKFLOWS_BASE}/`)) {
        await handleWorkflows(req, res, db, url, { key: bearerKey(req), now });
        return;
      }
      if (isWorkOrderWrite(req, url.pathname)) {
        await handleWorkOrderWrite(req, res, db, url.pathname, { key: bearerKey(req), gis, now });
        return;
      }
      if (req.method !== 'GET') {
        send(res, 405, { error: 'method_not_allowed', message: `${req.method} is not supported at ${url.pathname}` }, { Allow: 'GET' });
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
      // A single work order carries its version as an ETag, for use in If-Match when changing it.
      const etag = match.operation === 'getWorkOrder' ? { ETag: etagFor(getWorkOrder(db, body.item.id).version) } : {};
      send(res, 200, body, etag);
    } catch (err) {
      if (err instanceof RateLimitedError) send(res, 429, { error: 'too_many_requests', message: err.message }, { 'Retry-After': String(err.retryAfterSeconds) });
      else if (err instanceof PreconditionRequiredError) send(res, 428, { error: 'precondition_required', message: err.message });
      else if (err instanceof MapGenerationError) send(res, 422, { error: 'map_generation_error', message: err.message });
      else if (err instanceof ResponseFormatError) {
        console.error('API: response failed the published format check', err);
        send(res, 500, { error: 'response_format_error', message: 'Our response did not match the published format, so it was not sent.' });
      }
      else if (err instanceof ForbiddenError) send(res, 403, { error: 'forbidden', message: err.message });
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
