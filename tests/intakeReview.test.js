// STORY-015 step 2 — the human decision: a named person approves, corrects or rejects each draft.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '../server/db.js';
import { getWorkOrder, ValidationError, NotFoundError } from '../server/workOrders.js';
import { bootstrapAdministrator, createUser, grantRole, AccessDeniedError } from '../server/access.js';
import { submitPublicRequest } from '../server/publicRequests.js';
import { loadStandInTickets } from '../server/locateTickets.js';
import {
  approveDraft, correctDraft, rejectDraft, getDraft, listDrafts, receiveLocateTicket, draftNewArrivals, proposeDraft,
} from '../server/intake.js';

async function setup() {
  const db = openDatabase();
  const admin = bootstrapAdministrator(db, { email: 'jane.admin@herriman.example', display_name: 'Jane Admin' });
  const as = { actorUserId: admin.id };
  const person = (email, name, role) => {
    const u = createUser(db, { email, display_name: name }, as);
    grantRole(db, { userId: u.id, roleId: role }, as);
    return u;
  };
  const sue = person('sue@herriman.example', 'Sue Supervisor', 'supervisor');
  const ray = person('ray@herriman.example', 'Ray Supervisor', 'supervisor');
  const sam = person('sam@herriman.example', 'Sam Crew', 'field_crew');
  return { db, sue, ray, sam };
}
let n = 0;
async function request(db, description = 'Pothole about a foot wide in the right-hand lane', category = 'pothole') {
  const r = await submitPublicRequest(db, { description, category, location_text: '13400 S Rosecrest Rd (stand-in)', submission_id: `review-sub-${(n += 1).toString().padStart(4, '0')}` }, { ip: '203.0.113.7' });
  const req = db.prepare('SELECT id FROM service_requests WHERE tracking_code = ?').get(r.tracking_code);
  return listDrafts(db).find((d) => d.source_id === req.id);
}

// ---------- AC2: approving creates the work order and names who approved it ----------

test('approving creates the work order from the draft, and both name the person who approved it', async () => {
  const { db, sue } = await setup();
  const draft = await request(db);
  const { workOrder, draft: decided } = await approveDraft(db, draft.id, { actorUserId: sue.id, expectedVersion: draft.version });
  assert.deepEqual([workOrder.work_type, workOrder.location_text, workOrder.created_by], ['pothole', '13400 S Rosecrest Rd (stand-in)', 'sue@herriman.example']);
  assert.deepEqual([decided.status, decided.reviewed_by, decided.work_order_id], ['approved', sue.id, workOrder.id]);
  assert.equal(db.prepare('SELECT work_order_id FROM service_requests WHERE id = ?').get(draft.source_id).work_order_id, workOrder.id);
  const approval = db.prepare("SELECT * FROM audit_entries WHERE entity_id = ? AND action = 'intake_approve'").get(workOrder.id);
  assert.equal(approval.actor_user_id, sue.id);
  assert.equal(JSON.parse(approval.after_json).approved_by, 'Sue Supervisor');
});

// ---------- AC3: editing or rejecting keeps the original proposal ----------

test('a corrected draft becomes the work order as corrected; the agent\'s proposal is kept unchanged', async () => {
  const { db, sue } = await setup();
  const draft = await request(db);
  const saved = correctDraft(db, draft.id, { changes: { priority: 'high' }, actorUserId: sue.id });
  assert.equal(saved.final.priority, 'high');
  const { workOrder, draft: decided } = await approveDraft(db, draft.id, { changes: { title: 'Pothole: lane closure needed' }, actorUserId: sue.id });
  assert.deepEqual([workOrder.priority, workOrder.title], ['high', 'Pothole: lane closure needed'], 'my version is what is saved');
  assert.deepEqual(decided.proposed, draft.proposed, 'the original proposal is retained');
  const approval = db.prepare("SELECT after_json FROM audit_entries WHERE entity_type = 'intake_draft' AND action = 'approve'").get();
  assert.deepEqual(JSON.parse(approval.after_json).changed_from_proposal, ['title', 'priority']);
});

test('a rejected draft creates no work order; the reason and the proposal are kept', async () => {
  const { db, sue } = await setup();
  const draft = await request(db);
  const rejected = rejectDraft(db, draft.id, { reason: 'Duplicate of a crew report', actorUserId: sue.id });
  assert.deepEqual([rejected.status, rejected.review_note, rejected.reviewed_by], ['rejected', 'Duplicate of a crew report', sue.id]);
  assert.deepEqual(rejected.proposed, draft.proposed);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_orders').get().n, 0);
  assert.throws(() => rejectDraft(db, draft.id, { reason: 'x', actorUserId: sue.id }), /reason of 3 to 1000/);
});

// ---------- failure path: a field the agent could not determine ----------

test('a draft with an undetermined field cannot be approved until a person fills it in', async () => {
  const { db, sue } = await setup();
  const draft = await request(db, 'Something strange near the park, please look', 'citizen_request');
  assert.deepEqual(draft.undetermined.map((u) => u.field), ['work_type']);
  await assert.rejects(approveDraft(db, draft.id, { actorUserId: sue.id }), (err) => err instanceof ValidationError && /work_type must be filled in/.test(err.problems[0]));
  assert.equal(getDraft(db, draft.id).status, 'proposed', 'nothing changed');
  const { workOrder } = await approveDraft(db, draft.id, { changes: { work_type: 'tree' }, actorUserId: sue.id });
  assert.equal(workOrder.work_type, 'tree');
});

// ---------- failure path: two reviewers approve at the same time ----------

test('two reviewers approving at once: one work order, and the second is told who approved it', async () => {
  const { db, sue, ray } = await setup();
  const draft = await request(db);
  const results = await Promise.allSettled([
    approveDraft(db, draft.id, { actorUserId: sue.id, expectedVersion: draft.version }),
    approveDraft(db, draft.id, { actorUserId: ray.id, expectedVersion: draft.version }),
  ]);
  const won = results.filter((r) => r.status === 'fulfilled');
  const lost = results.filter((r) => r.status === 'rejected');
  assert.equal(won.length, 1);
  assert.equal(lost.length, 1);
  assert.match(lost[0].reason.message, /Sue Supervisor|changed since you opened it/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_orders').get().n, 1);

  const later = await approveDraft(db, draft.id, { actorUserId: ray.id }).catch((e) => e);
  assert.equal(later.name, 'DraftAlreadyDecided');
  assert.match(later.message, /Already approved by Sue Supervisor at/);
  const again = await approveDraft(db, draft.id, { actorUserId: sue.id });
  assert.deepEqual([again.duplicate, again.workOrder.id], [true, won[0].value.workOrder.id], 'a double-click by the approver gives the same work order');
});

// ---------- failure path: an approval after the source record changed ----------

test('approving after the source changed is refused; re-drafting keeps the old proposal and the new one can be approved', async () => {
  const { db, sue } = await setup();
  const draft = await request(db);
  db.prepare('UPDATE service_requests SET location_text = ? WHERE id = ?').run('12600 S Main St (stand-in)', draft.source_id);
  const refused = await approveDraft(db, draft.id, { actorUserId: sue.id }).catch((e) => e);
  assert.equal(refused.name, 'SourceChanged');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_orders').get().n, 0);

  const redrafted = await proposeDraft(db, { sourceType: 'citizen_request', sourceId: draft.source_id });
  assert.equal(getDraft(db, draft.id).status, 'superseded');
  assert.equal(redrafted.proposed.location_text, '12600 S Main St (stand-in)');
  const { workOrder } = await approveDraft(db, redrafted.id, { actorUserId: sue.id });
  assert.equal(workOrder.location_text, '12600 S Main St (stand-in)');
  const stale = await approveDraft(db, draft.id, { actorUserId: sue.id }).catch((e) => e);
  assert.equal(stale.name, 'DraftSuperseded');
});

test('an approval from an out-of-date view of the draft is refused', async () => {
  const { db, sue, ray } = await setup();
  const draft = await request(db);
  correctDraft(db, draft.id, { changes: { priority: 'urgent' }, actorUserId: ray.id });
  const refused = await approveDraft(db, draft.id, { actorUserId: sue.id, expectedVersion: draft.version }).catch((e) => e);
  assert.equal(refused.name, 'DraftVersionConflict');
});

// ---------- Trust: only named people with intake:approve decide ----------

test('only people with intake:approve can approve, correct or reject; nothing reaches the live queue otherwise', async () => {
  const { db, sam, sue } = await setup();
  const draft = await request(db);
  await assert.rejects(approveDraft(db, draft.id, { actorUserId: sam.id }), AccessDeniedError, 'field crew cannot approve');
  await assert.rejects(approveDraft(db, draft.id, {}), AccessDeniedError, 'no person, no approval');
  assert.throws(() => rejectDraft(db, draft.id, { reason: 'No', actorUserId: sam.id }), AccessDeniedError);
  assert.throws(() => correctDraft(db, draft.id, { changes: {}, actorUserId: sam.id }), AccessDeniedError);
  await assert.rejects(approveDraft(db, 'nope', { actorUserId: sue.id }), NotFoundError);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_orders').get().n, 0);
});

test('if the approval cannot be recorded, the draft is released and can be approved again; no second work order', async () => {
  const { db, sue } = await setup();
  const draft = await request(db);
  await assert.rejects(approveDraft(db, draft.id, { actorUserId: sue.id, audit: () => { throw new Error('audit store unavailable'); } }), /audit store unavailable/);
  const { workOrder } = await approveDraft(db, draft.id, { actorUserId: sue.id });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_orders').get().n, 1, 'the work order made on the first try is reused, not duplicated');
  assert.equal(getDraft(db, draft.id).work_order_id, workOrder.id);
});

// ---------- the Blue Stakes arrival path, and catching up ----------

test('a Blue Stakes ticket arrives and is drafted at once; approving links the ticket to its work order', async () => {
  const { db, sue } = await setup();
  const [incoming] = loadStandInTickets();
  const { ticket, draft } = await receiveLocateTicket(db, incoming);
  assert.equal(draft.source_id, ticket.id);
  assert.equal(draft.proposed.work_type, 'locate');
  const again = await receiveLocateTicket(db, incoming);
  assert.deepEqual([again.ticket.duplicate, again.draft.id], [true, draft.id], 'the feed re-sending a ticket makes one draft');
  const { workOrder } = await approveDraft(db, draft.id, { actorUserId: sue.id });
  assert.equal(db.prepare('SELECT work_order_id FROM locate_tickets WHERE id = ?').get(ticket.id).work_order_id, workOrder.id);
});

test('anything that arrived without a draft is drafted by the catch-up sweep, once', async () => {
  const { db } = await setup();
  db.prepare(`INSERT INTO locate_tickets (id, ticket_number, ticket_type, status, excavator_name, work_description, dig_address, received_at, due_at, created_at, updated_at)
              VALUES ('t-1', 'BST-1', 'normal', 'received', 'Example Excavating', 'Trench for conduit', '50 Example Way', '2026-11-10T00:00:00Z', '2026-11-12T00:00:00Z', '2026-11-10T00:00:00Z', '2026-11-10T00:00:00Z')`).run();
  assert.equal((await draftNewArrivals(db)).length, 1);
  assert.equal((await draftNewArrivals(db)).length, 0, 'running it again drafts nothing more');
});

test('an older database, where every request had to have a work order, is upgraded without losing a row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hwo-intake-'));
  const file = join(dir, 'old.db');
  try {
    // Today's schema, but with service_requests as it was before this story: the work order required.
    const fresh = openDatabase(file);
    fresh.close();
    const old = new DatabaseSync(file);
    old.exec(`DROP TABLE service_requests;
              CREATE TABLE service_requests (id TEXT PRIMARY KEY, tracking_code TEXT NOT NULL UNIQUE, submission_id TEXT NOT NULL UNIQUE,
                description TEXT NOT NULL, category TEXT NOT NULL, location_text TEXT NOT NULL, latitude REAL, longitude REAL, contact TEXT,
                work_order_id TEXT NOT NULL REFERENCES work_orders(id), submitted_at TEXT NOT NULL);
              INSERT INTO work_orders (id, title, work_type, created_by, created_at, updated_at) VALUES ('wo-1', 'Old', 'pothole', 'x', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
              INSERT INTO service_requests VALUES ('r-1', 'HWO-AAAAAA', 's-1', 'Old request text', 'pothole', 'Main St', NULL, NULL, 'x@example.com', 'wo-1', '2026-10-01T00:00:00Z');`);
    old.close();
    const db = openDatabase(file);
    const column = db.prepare('PRAGMA table_info(service_requests)').all().find((c) => c.name === 'work_order_id');
    assert.equal(column.notnull, 0, 'the link is now optional');
    assert.deepEqual({ ...db.prepare('SELECT id, work_order_id, contact FROM service_requests').get() }, { id: 'r-1', work_order_id: 'wo-1', contact: 'x@example.com' });
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
