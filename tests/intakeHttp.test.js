// STORY-015 step 3 — AI intake over HTTP: the queue, the draft, and decisions made by a named person.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../server/db.js';
import { bootstrapAdministrator, issueUserKey, createUser, grantRole } from '../server/access.js';
import { createApiClient } from '../server/api/clients.js';
import { createApiServer } from '../server/api/server.js';
import { startSession } from '../server/consoleSessions.js';

async function start() {
  const db = openDatabase();
  const admin = bootstrapAdministrator(db, { email: 'jane.admin@herriman.example', display_name: 'Jane Admin' });
  const as = { actorUserId: admin.id };
  const session = (email, name, role) => {
    const u = createUser(db, { email, display_name: name }, as);
    grantRole(db, { userId: u.id, roleId: role }, as);
    return { ...u, token: startSession(db, issueUserKey(db, u.id, as).key).token };
  };
  const sue = session('sue@herriman.example', 'Sue Supervisor', 'supervisor');
  const ray = session('ray@herriman.example', 'Ray Supervisor', 'supervisor');
  const sam = session('sam@herriman.example', 'Sam Crew', 'field_crew');
  const server = createApiServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (method, path, { token = sue.token, body, headers = {} } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
  };
  let n = 0;
  const citizen = async (description, category) => (await call('POST', '/public/requests', {
    token: null, body: { description, category, location_text: '13400 S Rosecrest Rd (stand-in)', contact: 'resident@example.com', submission_id: `http-intake-${(n += 1).toString().padStart(4, '0')}` },
  })).body.tracking_code;
  return { db, sue, ray, sam, call, citizen, stop: () => new Promise((resolve) => server.close(resolve)) };
}

test('an incoming citizen request appears in the queue as a filled-in draft, stating who performs the work and who must approve it', async (t) => {
  const { call, citizen, stop } = await start();
  t.after(stop);
  const code = await citizen('Large pothole in the right-hand lane', 'pothole');
  const queue = await call('GET', '/intake/drafts');
  assert.equal(queue.status, 200);
  const [item] = queue.body.items;
  assert.deepEqual([item.source.kind, item.source.reference, item.proposed.work_type, item.missing], ['Citizen request', code, 'pothole', []]);
  assert.deepEqual([item.performer_label, item.approver_label], ['Field crew', 'Supervisor']);
  assert.deepEqual(item.who_can_approve.sort(), ['Supervisor', 'System administrator']);
  assert.ok(!JSON.stringify(queue.body).includes('resident@example.com'), 'contact details never reach the queue');
  assert.equal((await call('GET', '/console/work-orders')).body.total, 0, 'nothing in the live list yet');
});

test('approving needs the version I opened; the work order is created and the screen shows who approved it', async (t) => {
  const { call, citizen, stop } = await start();
  t.after(stop);
  await citizen('Large pothole in the right-hand lane', 'pothole');
  const [{ id }] = (await call('GET', '/intake/drafts')).body.items;
  const opened = await call('GET', `/intake/drafts/${id}`);
  assert.equal(opened.headers.get('etag'), '"v1"');

  assert.equal((await call('POST', `/intake/drafts/${id}/approve`, { body: {} })).status, 428, 'If-Match required');
  const approved = await call('POST', `/intake/drafts/${id}/approve`, { body: { changes: { priority: 'high' } }, headers: { 'If-Match': '"v1"' } });
  assert.equal(approved.status, 201);
  assert.equal(approved.body.item.reviewed_by_name, 'Sue Supervisor');

  const detail = await call('GET', `/console/work-orders/${approved.body.work_order_id}`);
  assert.deepEqual([detail.body.item.priority, detail.body.intake.approved_by.name, detail.body.intake.changed_from_proposal], ['high', 'Sue Supervisor', ['priority']]);
  assert.ok(detail.body.history.some((h) => /Approved from AI intake by Sue Supervisor \(changed: priority\)/.test(h.what)));
  assert.equal((await call('GET', '/intake/drafts?status=approved')).body.items[0].reviewed_by_name, 'Sue Supervisor');
});

test('a second approver is told it is already approved, and by whom; a stale view gets 412 with the current draft', async (t) => {
  const { ray, call, citizen, stop } = await start();
  t.after(stop);
  await citizen('Large pothole in the right-hand lane', 'pothole');
  await citizen('Streetlight out on Main St', 'streetlight');
  const [first, second] = (await call('GET', '/intake/drafts')).body.items;

  await call('POST', `/intake/drafts/${first.id}/approve`, { body: {}, headers: { 'If-Match': '"v1"' } });
  const late = await call('POST', `/intake/drafts/${first.id}/approve`, { token: ray.token, body: {}, headers: { 'If-Match': '"v4"' } });
  assert.equal(late.status, 409);
  assert.equal(late.body.error, 'already_decided');
  assert.match(late.body.message, /Already approved by Sue Supervisor/);

  await call('POST', `/intake/drafts/${second.id}/correct`, { token: ray.token, body: { changes: { priority: 'urgent' } }, headers: { 'If-Match': '"v1"' } });
  const stale = await call('POST', `/intake/drafts/${second.id}/approve`, { body: {}, headers: { 'If-Match': '"v1"' } });
  assert.equal(stale.status, 412);
  assert.equal(stale.body.current.final.priority, 'urgent', 'shown what changed');
});

test('a draft whose source changed is refused with source_changed, and can be re-drafted', async (t) => {
  const { db, call, citizen, stop } = await start();
  t.after(stop);
  await citizen('Large pothole in the right-hand lane', 'pothole');
  const [draft] = (await call('GET', '/intake/drafts')).body.items;
  db.prepare('UPDATE service_requests SET location_text = ? WHERE id = ?').run('12600 S Main St (stand-in)', draft.source_id);
  const refused = await call('POST', `/intake/drafts/${draft.id}/approve`, { body: {}, headers: { 'If-Match': '"v1"' } });
  assert.deepEqual([refused.status, refused.body.error], [409, 'source_changed']);
  const redrafted = await call('POST', `/intake/drafts/${draft.id}/redraft`, { body: {} });
  assert.equal(redrafted.status, 201);
  assert.equal(redrafted.body.item.proposed.location_text, '12600 S Main St (stand-in)');
});

test('an undetermined field must be filled in before approval; rejecting keeps the proposal and tells the citizen only that it was not taken forward', async (t) => {
  const { call, citizen, stop } = await start();
  t.after(stop);
  const vagueCode = await citizen('Something strange near the park, please look', 'citizen_request');
  const [vague] = (await call('GET', '/intake/drafts')).body.items;
  assert.deepEqual(vague.missing, ['work_type']);
  const blocked = await call('POST', `/intake/drafts/${vague.id}/approve`, { body: {}, headers: { 'If-Match': '"v1"' } });
  assert.equal(blocked.status, 400);
  assert.match(blocked.body.problems[0], /work_type must be filled in/);

  const rejected = await call('POST', `/intake/drafts/${vague.id}/reject`, { body: { reason: 'Not city property' }, headers: { 'If-Match': '"v1"' } });
  assert.deepEqual([rejected.status, rejected.body.item.status, rejected.body.item.review_note], [200, 'rejected', 'Not city property']);
  const tracked = await call('GET', `/public/requests/${vagueCode}`, { token: null });
  assert.equal(tracked.body.item.status, 'Reviewed: not taken forward');
  assert.ok(!JSON.stringify(tracked.body).includes('Not city property'));
});

test('only a named person with intake:approve decides: field crew and outside systems are refused, and audited', async (t) => {
  const { db, sam, call, citizen, stop } = await start();
  t.after(stop);
  await citizen('Large pothole in the right-hand lane', 'pothole');
  const [{ id }] = (await call('GET', '/intake/drafts')).body.items;
  assert.equal((await call('POST', `/intake/drafts/${id}/approve`, { token: sam.token, body: {}, headers: { 'If-Match': '"v1"' } })).status, 403);
  const bot = createApiClient(db, { name: 'Auto approver', scopes: ['intake:approve'], actor: 'admin-1' });
  const byBot = await call('POST', `/intake/drafts/${id}/approve`, { token: bot.key, body: {}, headers: { 'If-Match': '"v1"' } });
  assert.equal(byBot.status, 403, 'no system can approve: a named person must');
  assert.equal((await call('GET', '/console/work-orders')).body.total, 0);
  const denied = db.prepare("SELECT after_json FROM audit_entries WHERE action = 'denied'").all().map((r) => JSON.parse(r.after_json).operation);
  assert.deepEqual(denied, ['intake_approve', 'intake_approve']);
});
