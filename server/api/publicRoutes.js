// Public endpoints for citizens (STORY-003). No API key: anyone may submit a request, follow their
// own request by tracking code, and see work orders that staff have published. Nothing here can
// change existing data, and nothing unpublished can be seen.
//
//   POST /api/v1/public/requests                 submit a request → { tracking_code, status, submitted_at }
//   GET  /api/v1/public/requests/{tracking code} follow your own request
//   GET  /api/v1/public/work-orders              recently updated published work orders
//   GET  /api/v1/public/work-orders/{id}         one published work order
//
// Errors are thrown and turned into JSON responses by server.js (400, 404, 429, 503 …).

import { readFileSync } from 'node:fs';
import { send, readJsonBody } from './http.js';
import { submitPublicRequest, getPublicView, listPublicWorkOrders, logUnreadableSubmission } from '../publicRequests.js';
import { ValidationError } from '../workOrders.js';

export const PUBLIC_BASE = '/api/v1/public';

// ---------- the public web page (/public) ----------

// The only files the page may serve. A fixed list means no path can reach any other file.
const PAGE_FILES = {
  '/public': ['index.html', 'text/html; charset=utf-8'],
  '/public/': ['index.html', 'text/html; charset=utf-8'],
  '/public/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/public/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};

// The page may load only its own files and call only this server.
export const PAGE_SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; "
    + "form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-cache',
};

export function isPagePath(pathname) {
  return pathname === '/public' || pathname.startsWith('/public/');
}

export function servePage(req, res, pathname) {
  const file = PAGE_FILES[pathname];
  if (!file || (req.method !== 'GET' && req.method !== 'HEAD')) {
    send(res, file ? 405 : 404, file ? { error: 'method_not_allowed', message: 'Use GET' } : { error: 'not_found', message: 'No such page' });
    return;
  }
  const content = readFileSync(new URL(`../public/${file[0]}`, import.meta.url));
  res.writeHead(200, { 'Content-Type': file[1], 'Content-Length': content.length, ...PAGE_SECURITY_HEADERS });
  res.end(req.method === 'HEAD' ? undefined : content);
}

const ROUTES = [
  { method: 'POST', pattern: /^\/requests$/, name: 'submit' },
  { method: 'GET', pattern: /^\/requests\/([^/]+)$/, name: 'track' },
  { method: 'GET', pattern: /^\/work-orders$/, name: 'list' },
  { method: 'GET', pattern: /^\/work-orders\/([^/]+)$/, name: 'view' },
];

export async function handlePublic(req, res, db, url, { now, ip }) {
  const path = url.pathname.slice(PUBLIC_BASE.length);
  const matches = ROUTES.filter((r) => r.pattern.test(path));
  if (!matches.length) {
    send(res, 404, { error: 'not_found', message: `No public endpoint at ${url.pathname}` });
    return;
  }
  const route = matches.find((r) => r.method === req.method);
  if (!route) {
    const allow = matches.map((r) => r.method).join(', ');
    send(res, 405, { error: 'method_not_allowed', message: `Use ${allow} here` }, { Allow: allow });
    return;
  }
  const param = decodeURIComponent(route.pattern.exec(path)[1] ?? '');
  const opts = now ? { now } : {};

  if (route.name === 'submit') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      // An unreadable submission is still a submission: log it with its IP before refusing it.
      if (err instanceof ValidationError) logUnreadableSubmission(db, { ip, detail: err.problems.join('; '), ...opts });
      throw err;
    }
    send(res, 201, await submitPublicRequest(db, body, { ip, ...opts }));
  } else if (route.name === 'track') {
    send(res, 200, { item: getPublicView(db, { trackingCode: param }) });
  } else if (route.name === 'list') {
    send(res, 200, { items: listPublicWorkOrders(db, { limit: url.searchParams.get('limit') ?? 20 }) });
  } else {
    send(res, 200, { item: getPublicView(db, { workOrderId: param }) });
  }
}
