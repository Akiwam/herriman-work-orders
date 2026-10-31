// The API request log (STORY-004 Trust: all API interactions are logged with timestamps and
// request details). startRequestLog() is called once at the top of every request in server.js,
// so no endpoint — public, keyed, refused or failing — can skip it.
//
// What is recorded: time received and finished, duration, method, path, query, calling client,
// IP, response status, error code, and the request body's field names and size.
// What is never recorded: API keys, and the values inside a request body (they can hold personal data).

import { randomUUID } from 'node:crypto';
import { authenticate } from './clients.js';

function clientName(db, req) {
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
  if (!match) return 'anonymous';
  try {
    return authenticate(db, match[1])?.name ?? 'invalid key';
  } catch (err) {
    // The database is unreachable; the request itself will already be answered with 503.
    console.error('Request log: could not look up the API client', err);
    return 'unknown';
  }
}

/**
 * Give the request an id (sent back as X-Request-Id) and write its log row when the response
 * finishes — or when the connection closes first. Returns the request id.
 */
export function startRequestLog(db, req, res, url, { ip, now = () => new Date().toISOString() } = {}) {
  const requestId = randomUUID();
  const receivedAt = now();
  const started = Date.now();
  res.setHeader('X-Request-Id', requestId);

  let written = false;
  const write = () => {
    if (written) return;
    written = true;
    const query = Object.fromEntries(url.searchParams);
    try {
      db.prepare(`
        INSERT INTO api_request_log (request_id, received_at, finished_at, duration_ms, method, path, query_json,
          client_name, client_ip, status, error_code, body_fields, body_bytes)
        VALUES (:request_id, :received_at, :finished_at, :duration_ms, :method, :path, :query_json,
          :client_name, :client_ip, :status, :error_code, :body_fields, :body_bytes)`).run({
        request_id: requestId,
        received_at: receivedAt,
        finished_at: now(),
        duration_ms: Date.now() - started,
        method: req.method,
        path: url.pathname,
        query_json: Object.keys(query).length ? JSON.stringify(query) : null,
        client_name: clientName(db, req),
        client_ip: ip ?? null,
        status: res.headersSent ? res.statusCode : null,
        error_code: res.errorCode ?? null,
        body_fields: req.bodySummary?.fields ? JSON.stringify(req.bodySummary.fields) : null,
        body_bytes: req.bodySummary?.bytes ?? null,
      });
    } catch (err) {
      // Most likely the database is down. Say so loudly; there is nowhere else to record it.
      console.error(`Request log: could not record request ${requestId}`, err);
    }
  };
  res.once('finish', write);
  res.once('close', write);
  return requestId;
}
