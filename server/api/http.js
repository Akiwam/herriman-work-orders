// Small HTTP helpers shared by every route module.

import { ValidationError } from '../workOrders.js';

const MAX_BODY_BYTES = 64 * 1024;

export function send(res, status, body, headers = {}) {
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

/** Read a JSON object body, at most 64 KB. Anything else is a ValidationError (400). */
export async function readJsonBody(req) {
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

/**
 * The address a request came from. By default the network connection's own address, which cannot
 * be faked. X-Forwarded-For is used only when `trustProxy` is set — i.e. the server sits behind a
 * known proxy or load balancer — because otherwise any client could write any address there.
 */
export function clientIp(req, { trustProxy = false } = {}) {
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  const address = req.socket?.remoteAddress ?? '';
  return address.startsWith('::ffff:') ? address.slice(7) : (address || 'unknown');
}
