// The staff console's own API (STORY-014). The console changes data only through the existing work
// order API, so every action is audited exactly as before; these endpoints sign people in and read what
// the console shows.
//
//   POST   /api/v1/console/session   sign in: { key } (a personal key) → { token, expires_at, user }
//   DELETE /api/v1/console/session   sign out (Authorization: Bearer <session token>)
//   GET    /api/v1/console/work-orders        the list: status, assignee, location; ?status=&assignee=&limit=&cursor=
//   GET    /api/v1/console/work-orders/{id}   one work order: record, full history and GIS record (live, or the saved copy)
//   GET    /api/v1/console/users              people work can be assigned to
// The reads need work_orders:read and are audited like every other read.

import { readFileSync } from 'node:fs';
import { send, readJsonBody } from './http.js';
import { PAGE_SECURITY_HEADERS } from './publicRoutes.js';
import { writeAudit, ValidationError } from '../workOrders.js';
import { startSession, endSession } from '../consoleSessions.js';
import { AuditUnavailableError, auditedRead, authenticate } from './clients.js';
import { listConsoleWorkOrders, consoleWorkOrderDetail, withLiveGis, assignableUsers } from '../consoleViews.js';

export const CONSOLE_API = '/api/v1/console';
const SESSION = `${CONSOLE_API}/session`;

const LIST = `${CONSOLE_API}/work-orders`;
const ONE = new RegExp(`^${LIST}/([^/]+)$`);
const USERS = `${CONSOLE_API}/users`;
const ME = `${CONSOLE_API}/me`;

export const isConsoleApiPath = (pathname) => [SESSION, LIST, USERS, ME].includes(pathname) || ONE.test(pathname);

// The console's own files, served with the same strict security headers as the public page.
const PAGE_FILES = {
  '/console': ['index.html', 'text/html; charset=utf-8'],
  '/console/': ['index.html', 'text/html; charset=utf-8'],
  '/console/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/console/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};
export const isConsolePagePath = (pathname) => Object.hasOwn(PAGE_FILES, pathname);

export function serveConsolePage(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, { error: 'method_not_allowed', message: 'Use GET' }, { Allow: 'GET' });
    return;
  }
  const [file, type] = PAGE_FILES[pathname];
  const content = readFileSync(new URL(`../console/${file}`, import.meta.url));
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': content.length, 'Cache-Control': 'no-store', ...PAGE_SECURITY_HEADERS });
  res.end(req.method === 'HEAD' ? undefined : content);
}

export async function handleConsoleApi(req, res, db, url, { key, now, gis }) {
  const opts = now ? { now } : {};
  if (url.pathname === ME) {
    const who = authenticate(db, key);
    if (!who || who.kind !== 'user') {
      send(res, 401, { error: 'unauthorized', message: 'Sign in to the console' });
      return;
    }
    const user = db.prepare('SELECT id, email, display_name FROM users WHERE id = ?').get(who.user_id);
    send(res, 200, { ...user, permissions: who.scopes });
    return;
  }
  const one = ONE.exec(url.pathname);
  if (url.pathname === LIST || url.pathname === USERS || one) {
    if (req.method !== 'GET') {
      send(res, 405, { error: 'method_not_allowed', message: 'The console reads here; changes go through /api/v1/work-orders' }, { Allow: 'GET' });
      return;
    }
    if (url.pathname === LIST) {
      const params = Object.fromEntries(url.searchParams);
      send(res, 200, auditedRead(db, { key, operation: 'consoleListWorkOrders', params }, () => listConsoleWorkOrders(db, params), opts));
    } else if (url.pathname === USERS) {
      send(res, 200, auditedRead(db, { key, operation: 'consoleAssignableUsers' }, () => ({ items: assignableUsers(db) }), opts));
    } else {
      const id = decodeURIComponent(one[1]);
      // Access is checked and the read audited first; only then is GIS asked for the live record.
      const detail = auditedRead(db, { key, operation: 'consoleWorkOrderDetail', params: { id } }, () => consoleWorkOrderDetail(db, id), opts);
      const body = await withLiveGis(detail, gis);
      send(res, 200, body, { ETag: `"v${body.item.version}"` });
    }
    return;
  }
  if (url.pathname === SESSION) {
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const extra = Object.keys(body).filter((f) => f !== 'key');
      if (extra.length || typeof body.key !== 'string') throw new ValidationError(['send only { key }, your personal key']);
      const session = startSession(db, body.key, opts);
      if (!session) {
        // A failed sign-in is a refused access attempt: audit it, without the key.
        try {
          writeAudit(db, { entityType: 'api_access', entityId: 'unknown', action: 'denied', actor: 'anonymous', after: { operation: 'consoleSignIn', reason: 'wrong, revoked or deactivated personal key' }, at: (now ?? (() => new Date().toISOString()))() });
        } catch (err) {
          throw new AuditUnavailableError(err);
        }
        send(res, 401, { error: 'unauthorized', message: 'That key did not sign you in. Check it, or ask an administrator for a new one.' });
        return;
      }
      // The token is in this response only, and must not be kept by any cache.
      send(res, 201, session, { 'Cache-Control': 'no-store' });
      return;
    }
    if (req.method === 'DELETE') {
      if (!key) {
        send(res, 401, { error: 'unauthorized', message: 'Send the session token to sign out.' });
        return;
      }
      send(res, 200, endSession(db, key, opts));
      return;
    }
    send(res, 405, { error: 'method_not_allowed', message: 'Use POST to sign in or DELETE to sign out' }, { Allow: 'POST, DELETE' });
  }
}
