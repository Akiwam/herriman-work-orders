// STORY-003 — public interface for citizen requests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../server/db.js';
import { getWorkOrder, updateWorkOrder, completeWorkOrder, ValidationError, NotFoundError } from '../server/workOrders.js';
import {
  submitPublicRequest, validateSubmission, PORTAL_ACTOR, publishWorkOrder, getPublicView, listPublicWorkOrders,
  purgeSubmissionIps, PublicNotFoundError,
} from '../server/publicRequests.js';

const IP = '203.0.113.7'; // documentation-range address, not a real person
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const log = (db) => db.prepare('SELECT * FROM public_submission_log ORDER BY id').all();

const good = (extra = {}) => ({
  description: 'Streetlight has been out for a week near the bus stop',
  location_text: 'Stand-in address: 140 Example Way',
  category: 'streetlight',
  submission_id: 'sub-0001-abcd',
  ...extra,
});

// ---------- AC1: a citizen request, when submitted, appears in the work order system ----------

test('AC1: a submitted request appears in the work order system, and the citizen gets a tracking code', async () => {
  const db = openDatabase();
  const r = await submitPublicRequest(db, good(), { ip: IP });

  assert.match(r.tracking_code, /^HWO-[2-9A-HJKMNP-Z]{6}$/);
  assert.equal(r.status, 'received');
  assert.equal(r.duplicate, false);
  assert.deepEqual(Object.keys(r).sort(), ['duplicate', 'status', 'submitted_at', 'tracking_code'], 'nothing internal goes back to the citizen');

  const req = db.prepare('SELECT * FROM service_requests WHERE tracking_code = ?').get(r.tracking_code);
  const wo = getWorkOrder(db, req.work_order_id);
  assert.equal(wo.description, 'Streetlight has been out for a week near the bus stop');
  assert.equal(wo.work_type, 'streetlight');
  assert.equal(wo.location_text, 'Stand-in address: 140 Example Way');
  assert.equal(wo.created_by, PORTAL_ACTOR);
  assert.equal(wo.status, 'open');
  assert.equal(wo.is_public, 0, 'new requests are not public until staff publish them');

  const audit = db.prepare("SELECT * FROM audit_entries WHERE entity_id = ? AND action = 'create'").get(wo.id);
  assert.equal(audit.actor, PORTAL_ACTOR, 'the work order is audited like any other');
});

test('a long description is shortened for the work order title but kept in full', async () => {
  const db = openDatabase();
  const long = 'Water is bubbling up through the sidewalk '.repeat(4).trim();
  const r = await submitPublicRequest(db, good({ description: long }), { ip: IP });
  const wo = getWorkOrder(db, db.prepare('SELECT work_order_id FROM service_requests WHERE tracking_code = ?').get(r.tracking_code).work_order_id);
  assert.ok(wo.title.length <= 80);
  assert.equal(wo.description, long);
});

test('the same submission sent twice makes one request and one work order', async () => {
  const db = openDatabase();
  const first = await submitPublicRequest(db, good(), { ip: IP });
  const again = await submitPublicRequest(db, good(), { ip: IP });
  assert.equal(again.duplicate, true);
  assert.equal(again.tracking_code, first.tracking_code);
  assert.equal(count(db, 'service_requests'), 1);
  assert.equal(count(db, 'work_orders'), 1);
});

// ---------- failure path: submission fails ----------

test('an invalid submission is refused with every problem listed, and nothing is created', async () => {
  const db = openDatabase();
  await assert.rejects(submitPublicRequest(db, { description: 'short', latitude: 200, contact: 7 }, { ip: IP }), (err) => {
    assert.ok(err instanceof ValidationError);
    for (const p of ['description must be 10 to 2000 characters', 'location_text is required',
      'contact must be text', 'latitude must be a number from -90 to 90']) {
      assert.ok(err.problems.includes(p), `missing problem: ${p}`);
    }
    return true;
  });
  await assert.rejects(submitPublicRequest(db, 'not an object', { ip: IP }), ValidationError);
  assert.equal(count(db, 'service_requests'), 0);
  assert.equal(count(db, 'work_orders'), 0);
  assert.deepEqual(validateSubmission(good()), []);
});

test('a submission without the caller passing an IP address is a programming error, not silently unlogged', async () => {
  const db = openDatabase();
  await assert.rejects(submitPublicRequest(db, good(), {}), /needs the submitter's IP address/);
  assert.equal(count(db, 'work_orders'), 0);
});

// ---------- AC3: all public submissions are logged with timestamps and IP addresses ----------

test('AC3: every submission — accepted, duplicate and rejected — is logged with its IP and time', async () => {
  const db = openDatabase();
  const at = () => '2026-10-30T12:00:00.000Z';
  await submitPublicRequest(db, good(), { ip: IP, now: at });
  await submitPublicRequest(db, good(), { ip: '198.51.100.20', now: at });
  await assert.rejects(submitPublicRequest(db, { description: 'x' }, { ip: '2001:db8::1', now: at }));

  const rows = log(db);
  assert.deepEqual(rows.map((r) => [r.outcome, r.ip_address, r.submitted_at]), [
    ['accepted', IP, '2026-10-30T12:00:00.000Z'],
    ['duplicate', '198.51.100.20', '2026-10-30T12:00:00.000Z'],
    ['rejected', '2001:db8::1', '2026-10-30T12:00:00.000Z'],
  ]);
  assert.match(rows[2].detail, /description must be/);
  assert.ok(rows[0].service_request_id);
});

// ---------- AC2: a public work order, when viewed, shows current status and history ----------

/** A citizen request that staff then work on: updated, published, completed — one minute apart. */
async function workedRequest() {
  const db = openDatabase();
  let minute = 0;
  const at = () => new Date(Date.UTC(2026, 9, 30, 9, minute++)).toISOString();
  const r = await submitPublicRequest(db, good({ contact: 'resident@example.com' }), { ip: IP, now: at });
  const woId = db.prepare('SELECT work_order_id FROM service_requests WHERE tracking_code = ?').get(r.tracking_code).work_order_id;
  await updateWorkOrder(db, woId, { priority: 'high', location_text: 'Stand-in address: 142 Example Way' }, { actor: 'supervisor.jones', now: at });
  publishWorkOrder(db, woId, { actor: 'supervisor.jones', now: at });
  await completeWorkOrder(db, woId, { note: 'Internal: replaced ballast, crew 7', actor: 'crew.smith', now: at });
  return { db, r, woId };
}

test('AC2: a published work order shows its current status and a dated history', async () => {
  const { db, woId } = await workedRequest();
  const view = getPublicView(db, { workOrderId: woId });
  assert.equal(view.status, 'Completed');
  assert.equal(view.category, 'streetlight');
  assert.equal(view.location, 'Stand-in address: 142 Example Way');
  assert.ok(view.completed_at);
  assert.deepEqual(view.history.map((h) => h.event), ['Request received', 'Work order updated', 'Work completed'],
    'publishing is internal and is not part of the public history');
  assert.ok(view.history.every((h) => !Number.isNaN(Date.parse(h.at))));
});

test('the public view never shows staff names, internal notes, contact details or IPs', async () => {
  const { db, r, woId } = await workedRequest();
  const shown = JSON.stringify([getPublicView(db, { workOrderId: woId }), getPublicView(db, { trackingCode: r.tracking_code }), listPublicWorkOrders(db)]);
  for (const hidden of ['supervisor.jones', 'crew.smith', 'public-portal', 'Internal: replaced ballast', 'resident@example.com', IP, 'before_json', 'priority']) {
    assert.ok(!shown.includes(hidden), `the public view leaked: ${hidden}`);
  }
});

test('a citizen can follow their own request by tracking code before it is published', async () => {
  const db = openDatabase();
  const r = await submitPublicRequest(db, good(), { ip: IP });
  const view = getPublicView(db, { trackingCode: r.tracking_code.toLowerCase() });
  assert.equal(view.reference, r.tracking_code);
  assert.equal(view.status, 'Open');
  assert.deepEqual(view.history.map((h) => h.event), ['Request received']);
});

// ---------- failure paths: unauthorized access, data not displayed ----------

test('an unpublished work order looks exactly like one that does not exist', async () => {
  const db = openDatabase();
  const r = await submitPublicRequest(db, good(), { ip: IP });
  const woId = db.prepare('SELECT work_order_id FROM service_requests WHERE tracking_code = ?').get(r.tracking_code).work_order_id;

  let hiddenMessage;
  let missingMessage;
  assert.throws(() => getPublicView(db, { workOrderId: woId }), (e) => { hiddenMessage = e.message; return e instanceof PublicNotFoundError; });
  assert.throws(() => getPublicView(db, { workOrderId: 'no-such-id' }), (e) => { missingMessage = e.message; return e instanceof PublicNotFoundError; });
  assert.equal(hiddenMessage, missingMessage, 'nobody can tell a hidden work order from a missing one');
  assert.throws(() => getPublicView(db, { trackingCode: 'HWO-ZZZZZZ' }), PublicNotFoundError);
  assert.throws(() => getPublicView(db, {}), ValidationError);
  assert.ok(new PublicNotFoundError() instanceof NotFoundError, 'the API turns it into a 404');
});

test('only published work orders are listed publicly, and unpublishing takes one down again', async () => {
  const { db, woId } = await workedRequest();
  await submitPublicRequest(db, good({ submission_id: 'sub-0002-efgh' }), { ip: IP }); // not published
  assert.deepEqual(listPublicWorkOrders(db).map((w) => w.id), [woId]);

  publishWorkOrder(db, woId, { actor: 'supervisor.jones', isPublic: false });
  assert.deepEqual(listPublicWorkOrders(db), []);
  assert.throws(() => getPublicView(db, { workOrderId: woId }), PublicNotFoundError);
  const actions = db.prepare('SELECT action FROM audit_entries WHERE entity_id = ? ORDER BY id').all(woId).map((a) => a.action);
  assert.ok(actions.includes('publish') && actions.includes('unpublish'), 'publishing is audited');
});

test('publishing needs an actor and an existing work order', () => {
  const db = openDatabase();
  assert.throws(() => publishWorkOrder(db, 'x', {}), /actor is required/);
  assert.throws(() => publishWorkOrder(db, 'no-such-id', { actor: 'supervisor.jones' }), NotFoundError);
});

// ---------- IP retention ----------

test('IP addresses older than the retention period are cleared; the rest of the log stays', async () => {
  const db = openDatabase();
  await submitPublicRequest(db, good(), { ip: IP, now: () => '2026-07-01T00:00:00.000Z' });
  await submitPublicRequest(db, good({ submission_id: 'sub-0003-ijkl' }), { ip: '198.51.100.20', now: () => '2026-10-29T00:00:00.000Z' });

  const cleared = purgeSubmissionIps(db, { now: () => '2026-10-30T00:00:00.000Z' });
  assert.equal(cleared, 1);
  assert.deepEqual(log(db).map((r) => [r.outcome, r.ip_address]), [['accepted', null], ['accepted', '198.51.100.20']]);
  assert.equal(purgeSubmissionIps(db, { now: () => '2026-10-30T00:00:00.000Z' }), 0, 'running it again changes nothing');
});

test('the IP address and contact never appear in the work order or its audit entry', async () => {
  const db = openDatabase();
  const r = await submitPublicRequest(db, good({ contact: 'resident@example.com' }), { ip: IP });
  const req = db.prepare('SELECT * FROM service_requests WHERE tracking_code = ?').get(r.tracking_code);
  const everything = JSON.stringify([getWorkOrder(db, req.work_order_id), db.prepare('SELECT * FROM audit_entries').all()]);
  assert.ok(!everything.includes(IP));
  assert.ok(!everything.includes('resident@example.com'));
});
