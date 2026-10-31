// User access and the audit trail over HTTP (STORY-007, REQ-047).
//
//   GET    /api/v1/roles                       the roles and their permissions        (access:admin)
//   GET    /api/v1/users                       every user with their roles             (access:admin)
//   POST   /api/v1/users                       add a user: { email, display_name }     (access:admin)
//   POST   /api/v1/users/{id}/roles            grant a role: { role_id }               (access:admin)
//   DELETE /api/v1/users/{id}/roles/{role_id}  remove a role                           (access:admin)
//   POST   /api/v1/users/{id}/key              issue a personal key (shown once)       (access:admin)
//   DELETE /api/v1/users/{id}/key              revoke their key                        (access:admin)
//   GET    /api/v1/audit                       the audit trail, filtered               (audit:read)
//
// Access changes must be made by a person, with their own key: an outside system's key is refused
// even if it was given access:admin, so every access change has a verified user id in the audit trail.
// The functions in server/access.js check the permission again, so the rule holds outside HTTP too.

import { send, readJsonBody } from './http.js';
import { requireAccess, auditedRead, ForbiddenError } from './clients.js';
import { ValidationError, NotFoundError } from '../workOrders.js';
import {
  createUser, grantRole, revokeRole, issueUserKey, revokeUserKey, listRoles, getUser, ACCESS_ADMIN, AUDIT_READ,
} from '../access.js';
import { listAuditEntries } from '../auditTrail.js';

export const USER_FIELDS = ['email', 'display_name'];
export const GRANT_FIELDS = ['role_id'];
const USERS = /^\/api\/v1\/users(?:\/([^/]+)(?:\/(roles|key)(?:\/([^/]+))?)?)?$/;

export const isAccessPath = (pathname) => pathname === '/api/v1/roles' || pathname === '/api/v1/audit' || USERS.test(pathname);

function onlyFields(body, allowed) {
  const problems = Object.keys(body).filter((f) => !allowed.includes(f)).map((f) => `${f} is not a field this endpoint accepts`);
  if (problems.length) throw new ValidationError(problems);
}

/** The person making an access change. A system key is refused: access changes need a verified person. */
function administrator(db, key, operation, params) {
  const client = requireAccess(db, { key, operation, params, scope: ACCESS_ADMIN });
  if (client.kind !== 'user') throw new ForbiddenError(`${ACCESS_ADMIN} with a personal key (access changes must be made by a person)`);
  return client.user_id;
}

function methodNotAllowed(res, allowed) {
  send(res, 405, { error: 'method_not_allowed', message: `Use ${allowed} here` }, { Allow: allowed });
}

export async function handleAccess(req, res, db, url, { key, now } = {}) {
  const opts = now ? { now } : {};
  const params = Object.fromEntries(url.searchParams);

  if (url.pathname === '/api/v1/audit') {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    send(res, 200, auditedRead(db, { key, operation: 'readAuditTrail', params, scope: AUDIT_READ }, () => listAuditEntries(db, params), opts));
    return;
  }
  if (url.pathname === '/api/v1/roles') {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    send(res, 200, auditedRead(db, { key, operation: 'listRoles', scope: ACCESS_ADMIN }, () => ({ items: listRoles(db) }), opts));
    return;
  }

  const [, rawId, sub, rawRole] = USERS.exec(url.pathname);
  const userId = rawId ? decodeURIComponent(rawId) : null;
  const roleId = rawRole ? decodeURIComponent(rawRole) : null;

  if (!userId) {
    if (req.method === 'GET') {
      const read = () => ({ items: db.prepare('SELECT id FROM users ORDER BY email').all().map((u) => getUser(db, u.id)) });
      send(res, 200, auditedRead(db, { key, operation: 'listUsers', scope: ACCESS_ADMIN }, read, opts));
      return;
    }
    if (req.method !== 'POST') return methodNotAllowed(res, 'GET, POST');
    const actorUserId = administrator(db, key, 'createUser', {});
    const body = await readJsonBody(req);
    onlyFields(body, USER_FIELDS);
    const user = createUser(db, body, { actorUserId, ...opts });
    send(res, 201, { item: user }, { Location: `/api/v1/users/${user.id}` });
    return;
  }

  if (sub === 'roles') {
    if (roleId) {
      if (req.method !== 'DELETE') return methodNotAllowed(res, 'DELETE');
      const actorUserId = administrator(db, key, 'revokeRole', { user_id: userId, role_id: roleId });
      const { user, changed } = revokeRole(db, { userId, roleId }, { actorUserId, ...opts });
      send(res, 200, { item: user, changed });
      return;
    }
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const actorUserId = administrator(db, key, 'grantRole', { user_id: userId });
    const body = await readJsonBody(req);
    onlyFields(body, GRANT_FIELDS);
    if (typeof body.role_id !== 'string') throw new ValidationError(['role_id is required']);
    const { user, changed } = grantRole(db, { userId, roleId: body.role_id }, { actorUserId, ...opts });
    send(res, 200, { item: user, changed });
    return;
  }

  if (sub === 'key' && !roleId) {
    if (req.method === 'POST') {
      const actorUserId = administrator(db, key, 'issueUserKey', { user_id: userId });
      const { user, key: issued } = issueUserKey(db, userId, { actorUserId, ...opts });
      // The key is in this response only. no-store: it must not be kept by a browser or proxy cache.
      send(res, 201, { item: user, key: issued, note: 'Give this key to the user now. It cannot be shown again.' }, { 'Cache-Control': 'no-store' });
      return;
    }
    if (req.method === 'DELETE') {
      const actorUserId = administrator(db, key, 'revokeUserKey', { user_id: userId });
      send(res, 200, revokeUserKey(db, userId, { actorUserId, ...opts }));
      return;
    }
    return methodNotAllowed(res, 'POST, DELETE');
  }

  if (sub || roleId) {
    send(res, 404, { error: 'not_found', message: `No endpoint at ${url.pathname}` });
    return;
  }
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  const body = auditedRead(db, { key, operation: 'getUser', params: { id: userId }, scope: ACCESS_ADMIN }, () => {
    const user = getUser(db, userId);
    if (!user) throw Object.assign(new NotFoundError(userId), { message: `No user ${userId}` });
    return { item: user };
  }, opts);
  send(res, 200, body);
}
