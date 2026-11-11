// STORY-014 step 1 — assigning work orders, and signing in to the console.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../server/db.js';
import {
  createWorkOrder, completeWorkOrder, assignWorkOrder, getWorkOrder, ValidationError, ConflictError, VersionConflictError,
} from '../server/workOrders.js';
import { bootstrapAdministrator, issueUserKey, createUser, grantRole, setUserActive } from '../server/access.js';
import { createApiServer } from '../server/api/server.js';
import { IDLE_MINUTES } from '../server/consoleSessions.js';

async function setup() {
  const db = openDatabase();
  const admin = bootstrapAdministrator(db, { email: 'jane.admin@herriman.example', display_name: 'Jane Admin' });
  const as = { actorUserId: admin.id };
  const person = (email, name, role) => {
    const user = createUser(db, { email, display_name: name }, as);
    grantRole(db, { userId: user.id, roleId: role }, as);
    return { ...user, key: issueUserKey(db, user.id, as).key };
  };
  const sam = person('sam@herriman.example', 'Sam Crew', 'field_crew');
  const pat = person('pat@herriman.example', 'Pat Planner', 'planner');
  const wo = await createWorkOrder(db, { title: 'Pothole on Main St', work_type: 'pothole', location_text: 'Stand-in', created_by: 'clerk-1' });
  return { db, admin, sam, pat, wo };
}
const assignAudits = (db, id) => db.prepare("SELECT * FROM audit_entries WHERE entity_id = ? AND action = 'assign' ORDER BY id").all(id);

// ---------- assigning ----------

test('a work order is assigned to a person, versioned and audited; the same assignment again changes nothing', async () => {
  const { db, sam, wo } = await setup();
  assert.equal(getWorkOrder(db, wo.id).assigned_to, null, 'starts unassigned');
  const { workOrder, changed } = assignWorkOrder(db, wo.id, { assigneeUserId: sam.id, actor: 'jane.admin@herriman.example', expectedVersion: 1 });
  assert.deepEqual([changed, workOrder.assigned_to, workOrder.version], [true, sam.id, 2]);
  assert.equal(assignWorkOrder(db, wo.id, { assigneeUserId: sam.id, actor: 'jane' }).changed, false);
  const [entry] = assignAudits(db, wo.id);
  assert.deepEqual(JSON.parse(entry.after_json), { assigned_to: sam.id, version: 2 });

  assignWorkOrder(db, wo.id, { assigneeUserId: null, actor: 'jane' });
  assert.equal(getWorkOrder(db, wo.id).assigned_to, null, 'null unassigns');
  assert.equal(assignAudits(db, wo.id).length, 2);
});

test('work is never assigned to someone who could not act on it, and bad assignments change nothing', async () => {
  const { db, pat, sam, wo } = await setup();
  assert.throws(() => assignWorkOrder(db, wo.id, { assigneeUserId: pat.id, actor: 'jane' }), /allowed to work on work orders/, 'a planner cannot change work orders');
  assert.throws(() => assignWorkOrder(db, wo.id, { assigneeUserId: 'nobody', actor: 'jane' }), ValidationError);
  assert.throws(() => assignWorkOrder(db, wo.id, { assigneeUserId: sam.id, actor: 'jane', expectedVersion: 7 }), VersionConflictError);
  assert.throws(() => assignWorkOrder(db, wo.id, { assigneeUserId: sam.id, actor: 'jane', audit: () => { throw new Error('audit store unavailable'); } }), /audit store unavailable/);
  assert.equal(getWorkOrder(db, wo.id).assigned_to, null);

  await completeWorkOrder(db, wo.id, { note: 'Filled', actor: 'crew' });
  assert.throws(() => assignWorkOrder(db, wo.id, { assigneeUserId: sam.id, actor: 'jane' }), ConflictError);
});

// ---------- signing in, over HTTP ----------

async function serve(db) {
  const server = createApiServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (method, path, { token, body, headers = {} } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
  };
  return { call, stop: () => new Promise((resolve) => server.close(resolve)) };
}

test('signing in with a personal key gives a session that acts as that person, with their permissions, in the same audit trail', async (t) => {
  const { db, sam, wo } = await setup();
  const { call, stop } = await serve(db);
  t.after(stop);
  const signIn = await call('POST', '/console/session', { body: { key: sam.key } });
  assert.equal(signIn.status, 201);
  assert.equal(signIn.headers.get('cache-control'), 'no-store');
  assert.match(signIn.body.token, /^hws_[0-9a-f]{8}_/);
  assert.equal(signIn.body.user.email, 'sam@herriman.example');
  assert.ok(!JSON.stringify(signIn.body).includes(sam.key), 'the personal key is not sent back');
  const token = signIn.body.token;

  assert.equal((await call('GET', '/work-orders', { token })).status, 200);
  assert.equal((await call('GET', '/heat-maps', { token })).status, 403, 'field crew permissions, exactly');
  const assigned = await call('POST', `/work-orders/${wo.id}/assign`, { token, body: { assignee_user_id: sam.id }, headers: { 'If-Match': '"v1"' } });
  assert.equal(assigned.status, 200);
  const [entry] = assignAudits(db, wo.id);
  assert.deepEqual([entry.actor, entry.actor_user_id], ['sam@herriman.example', sam.id], 'a console action is audited exactly like the API');

  const stored = JSON.stringify(db.prepare('SELECT * FROM console_sessions').all());
  assert.ok(!stored.includes(token.slice(13)), 'only a hash of the token is stored');
});

test('a wrong key does not sign in, and the attempt is audited without the key', async (t) => {
  const { db } = await setup();
  const { call, stop } = await serve(db);
  t.after(stop);
  const res = await call('POST', '/console/session', { body: { key: 'hwu_00000000_Zq9SecretGuess' } });
  assert.equal(res.status, 401);
  const denied = db.prepare("SELECT * FROM audit_entries WHERE action = 'denied'").get();
  assert.equal(JSON.parse(denied.after_json).operation, 'consoleSignIn');
  assert.ok(!JSON.stringify(denied).includes('Zq9SecretGuess'), 'the key that was tried is not recorded');
});

test('a session ends after 30 idle minutes, after 8 hours, on sign-out, and when the person is deactivated', async (t) => {
  const { db, admin, sam } = await setup();
  const { call, stop } = await serve(db);
  t.after(stop);
  const signIn = async () => (await call('POST', '/console/session', { body: { key: sam.key } })).body.token;
  const works = async (token) => (await call('GET', '/work-orders', { token })).status;

  const idle = await signIn();
  db.prepare('UPDATE console_sessions SET last_seen_at = ?').run(new Date(Date.now() - (IDLE_MINUTES + 1) * 60000).toISOString());
  assert.equal(await works(idle), 401, 'idle too long');

  const old = await signIn();
  db.prepare("UPDATE console_sessions SET expires_at = ? WHERE ended_at IS NULL AND last_seen_at > ?").run(new Date(Date.now() - 1000).toISOString(), new Date(Date.now() - 60000).toISOString());
  assert.equal(await works(old), 401, 'past its 8 hours');

  const out = await signIn();
  assert.equal(await works(out), 200);
  assert.deepEqual((await call('DELETE', '/console/session', { token: out })).body, { ended: true });
  assert.equal(await works(out), 401, 'signed out');
  assert.deepEqual((await call('DELETE', '/console/session', { token: out })).body, { ended: false }, 'signing out twice is harmless');

  const live = await signIn();
  setUserActive(db, sam.id, false, { actorUserId: admin.id });
  assert.equal(await works(live), 401, 'deactivated: the session stops at once');
});
