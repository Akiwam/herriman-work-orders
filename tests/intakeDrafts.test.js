// STORY-015 step 1 — the intake agent drafts work orders from citizen requests and Blue Stakes tickets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { openDatabase } from '../server/db.js';
import { createWorkOrder } from '../server/workOrders.js';
import { proposeDraft, getDraft, listDrafts, ruleBasedDrafter, STANDIN_AGENT } from '../server/intake.js';

// Sources are inserted directly here; the next step routes the real STORY-003 and STORY-013 paths to drafting.
async function citizenRequest(db, { description, category = 'citizen_request', location_text = '13400 S Rosecrest Rd (stand-in)', contact = 'resident@example.com' }) {
  const wo = await createWorkOrder(db, { title: 'placeholder', work_type: 'x', location_text: 'x', created_by: 'test' }); // the column is still required until step 2
  const id = randomUUID();
  db.prepare(`INSERT INTO service_requests (id, tracking_code, submission_id, description, category, location_text, contact, work_order_id, submitted_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, `HWO-${id.slice(0, 6).toUpperCase()}`, `sub-${id}`, description, category, location_text, contact, wo.id, '2026-11-10T15:00:00.000Z');
  return id;
}
function locateTicket(db, { ticketType = 'normal', digAddress = '200 Example Way (stand-in)' } = {}) {
  const id = randomUUID();
  db.prepare(`INSERT INTO locate_tickets (id, ticket_number, ticket_type, status, excavator_name, work_description, dig_address, received_at, due_at, created_at, updated_at)
              VALUES (?, ?, ?, 'received', 'Example Excavating', 'Install a new water service line', ?, '2026-11-10T15:00:00.000Z', '2026-11-12T15:00:00.000Z', '2026-11-10T15:00:00.000Z', '2026-11-10T15:00:00.000Z')`)
    .run(id, `BST-${id.slice(0, 6)}`, ticketType, digAddress);
  return id;
}

test('a citizen request arrives as a draft with its fields filled in, and the agent never sees the contact details', async () => {
  const db = openDatabase();
  const id = await citizenRequest(db, { description: 'Large pothole in the right-hand lane, cars are swerving' });
  const draft = await proposeDraft(db, { sourceType: 'citizen_request', sourceId: id });
  assert.equal(draft.status, 'proposed');
  assert.equal(draft.drafted_by, STANDIN_AGENT, 'it says plainly that this is the rule-based stand-in');
  assert.deepEqual([draft.proposed.work_type, draft.proposed.priority, draft.proposed.location_text], ['pothole', 'normal', '13400 S Rosecrest Rd (stand-in)']);
  assert.match(draft.proposed.title, /^Pothole: Large pothole/);
  assert.deepEqual(draft.undetermined, []);
  assert.deepEqual([draft.performer, draft.approver], ['field_crew', 'supervisor']);
  assert.ok(!JSON.stringify(draft).includes('resident@example.com'));
  const entry = db.prepare("SELECT * FROM audit_entries WHERE entity_type = 'intake_draft' AND action = 'propose'").get();
  assert.equal(entry.actor, STANDIN_AGENT);
});

test('a Blue Stakes ticket arrives as a locate-and-mark draft; an emergency is drafted as urgent', async () => {
  const db = openDatabase();
  const draft = await proposeDraft(db, { sourceType: 'locate_ticket', sourceId: locateTicket(db, { ticketType: 'emergency' }) });
  assert.equal(draft.proposed.work_type, 'locate');
  assert.equal(draft.proposed.priority, 'urgent');
  assert.equal(draft.proposed.location_text, '200 Example Way (stand-in)');
  assert.match(draft.proposed.description, /Response due to Blue Stakes by 2026-11-12/);
});

test('a field the agent could not determine is left empty and listed with the reason — never guessed', async () => {
  const db = openDatabase();
  const vague = await proposeDraft(db, { sourceType: 'citizen_request', sourceId: await citizenRequest(db, { description: 'Something strange near the park, please look' }) });
  assert.equal(vague.proposed.work_type, null);
  assert.deepEqual(vague.undetermined.map((u) => u.field), ['work_type']);
  assert.match(vague.undetermined[0].reason, /no known work type mentioned/);

  const both = await proposeDraft(db, { sourceType: 'citizen_request', sourceId: await citizenRequest(db, { description: 'The streetlight fell onto the sidewalk' }) });
  assert.match(both.undetermined[0].reason, /could match streetlight or sidewalk/, 'two possible types: a person decides');

  const noAddress = await proposeDraft(db, { sourceType: 'locate_ticket', sourceId: locateTicket(db, { digAddress: '   ' }) });
  assert.deepEqual(noAddress.undetermined.map((u) => u.field), ['location_text']);
});

test('danger words raise the priority, and the draft says why', () => {
  const out = ruleBasedDrafter({ kind: 'citizen_request', reference: 'HWO-1', category: 'water_leak', description: 'Water main burst, flooding the road', location_text: 'Main St' });
  assert.equal(out.fields.priority, 'high');
  assert.match(out.fields.description, /raised to high: mentions "flooding"/);
});

test('proposing again for an unchanged source gives the same draft; a changed source supersedes it and keeps the old one', async () => {
  const db = openDatabase();
  const id = await citizenRequest(db, { description: 'Graffiti on the underpass wall' });
  const first = await proposeDraft(db, { sourceType: 'citizen_request', sourceId: id });
  const again = await proposeDraft(db, { sourceType: 'citizen_request', sourceId: id });
  assert.deepEqual([again.id, again.duplicate], [first.id, true]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM intake_drafts').get().n, 1);

  db.prepare('UPDATE service_requests SET location_text = ? WHERE id = ?').run('Underpass at 12600 S (stand-in)', id);
  const redrafted = await proposeDraft(db, { sourceType: 'citizen_request', sourceId: id });
  assert.notEqual(redrafted.id, first.id);
  assert.equal(getDraft(db, first.id).status, 'superseded', 'the earlier proposal is kept');
  assert.deepEqual(listDrafts(db).map((d) => d.id), [redrafted.id], 'one open draft per source');
});

test('if an AI model fails or returns something unusable, the stand-in drafts instead, and the draft records why', async () => {
  const db = openDatabase();
  const id = await citizenRequest(db, { description: 'Streetlight out on Main St' });
  const broken = async () => ({ fields: { title: 7, colour: 'red' }, undetermined: [] });
  const draft = await proposeDraft(db, { sourceType: 'citizen_request', sourceId: id }, { drafter: broken, agentName: 'Example model' });
  assert.equal(draft.drafted_by, STANDIN_AGENT);
  assert.match(draft.fallback, /Example model could not draft \(unusable draft: colour is not a draft field; title must be text or empty\)/);
  assert.equal(draft.proposed.work_type, 'streetlight');

  const db2 = openDatabase();
  const good = async () => ({ fields: { title: 'Streetlight out', work_type: 'streetlight', priority: 'normal', location_text: 'Main St', description: 'From the model' }, undetermined: [] });
  const fromModel = await proposeDraft(db2, { sourceType: 'citizen_request', sourceId: await citizenRequest(db2, { description: 'Streetlight out on Main St' }) }, { drafter: good, agentName: 'Example model' });
  assert.deepEqual([fromModel.drafted_by, fromModel.proposed.description, fromModel.fallback], ['Example model', 'From the model', null]);
});

test('if the audit entry cannot be written, no draft is saved', async () => {
  const db = openDatabase();
  const id = await citizenRequest(db, { description: 'Pothole on Main St' });
  await assert.rejects(proposeDraft(db, { sourceType: 'citizen_request', sourceId: id }, { audit: () => { throw new Error('audit store unavailable'); } }), /audit store unavailable/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM intake_drafts').get().n, 0);
});
