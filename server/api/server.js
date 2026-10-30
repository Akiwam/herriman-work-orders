// The read API over HTTP (STORY-011), using Node's built-in http module.
//
//   GET /api/v1/openapi.json              the contract (no key needed; contains no data)
//   GET /api/v1/work-orders               list, a page at a time
//   GET /api/v1/work-orders/changes       ?since=<ISO time>
//   GET /api/v1/work-orders/search        ?q=<keywords>
//   GET /api/v1/work-orders/{id}          one work order
//
// Every data request goes through auditedRead(): no valid key → 401, and no audit entry → no data.
// Errors are always JSON. If the database cannot be reached the answer is 503, never partial data.

import { createServer } from 'node:http';
import { auditedRead, UnauthorizedError, AuditUnavailableError } from './clients.js';
import { listWorkOrders, workOrderChanges, searchWorkOrders, getPublicWorkOrder } from './workOrderFeed.js';
import { openApiDocument } from './openapi.js';
import { ValidationError, NotFoundError } from '../workOrders.js';

const BASE = '/api/v1';

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

/** Match a path to one of the reads. Returns { operation, read, params } or null. */
function route(pathname, query) {
  const params = Object.fromEntries(query);
  if (pathname === `${BASE}/work-orders`) return { operation: 'listWorkOrders', read: listWorkOrders, params };
  if (pathname === `${BASE}/work-orders/changes`) return { operation: 'workOrderChanges', read: workOrderChanges, params };
  if (pathname === `${BASE}/work-orders/search`) return { operation: 'searchWorkOrders', read: searchWorkOrders, params };
  const one = new RegExp(`^${BASE}/work-orders/([^/]+)$`).exec(pathname);
  if (one) return { operation: 'getWorkOrder', read: getPublicWorkOrder, params: { id: decodeURIComponent(one[1]) } };
  return null;
}

export function createApiServer(db, { now, requestTimeoutMs = 10_000 } = {}) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET') {
      send(res, 405, { error: 'method_not_allowed', message: 'This API is read-only: use GET' }, { Allow: 'GET' });
      return;
    }
    if (url.pathname === `${BASE}/openapi.json`) {
      send(res, 200, openApiDocument());
      return;
    }
    const match = route(url.pathname, url.searchParams);
    if (!match) {
      send(res, 404, { error: 'not_found', message: `No endpoint at ${url.pathname}` });
      return;
    }

    try {
      const body = auditedRead(db, { key: bearerKey(req), operation: match.operation, params: match.params },
        () => match.read(db, match.params), now ? { now } : {});
      send(res, 200, body);
    } catch (err) {
      if (err instanceof UnauthorizedError) send(res, 401, { error: 'unauthorized', message: err.message }, { 'WWW-Authenticate': 'Bearer' });
      else if (err instanceof ValidationError) send(res, 400, { error: 'invalid_request', message: err.message, problems: err.problems });
      else if (err instanceof NotFoundError) send(res, 404, { error: 'not_found', message: err.message });
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
