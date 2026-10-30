// STORY-013 — Blue Stakes locate tickets: update, respond, complete.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../server/db.js';
import { ValidationError, NotFoundError, ConflictError, createWorkOrder } from '../server/workOrders.js';
import {
  importLocateTicket, getLocateTicket, findLocateTicketByNumber, loadStandInTickets, validateIncomingTicket, updateLocateTicket,
  respondToLocateTicket, deliverPendingResponses, completeLocateTicket, LocateTicketNotFoundError, FEED_ACTOR,
} from '../server/locateTickets.js';
import { createBlueStakesClient, createBlueStakesLogger, createStandInBlueStakes } from '../server/bluestakes.js';

/** The stand-in one-call centre, wrapped the way production code uses it, with fast retries. */
function oneCallCentre(db, backend = createStandInBlueStakes()) {
  return { backend, bluestakes: createBlueStakesClient(backend, { log: createBlueStakesLogger(db), timeoutMs: 200, attempts: 2, delayMs: 1 }) };
}

const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const ticketAudits = (db) => db.prepare("SELECT * FROM audit_entries WHERE entity_type = 'locate_ticket' ORDER BY id").all();
const sample = () => structuredClone(loadStandInTickets()[0]);

// ---------- import ----------

test('a ticket from the feed is imported as "received", and the import is audited', () => {
  const db = openDatabase();
  const t = importLocateTicket(db, sample());
  assert.equal(t.duplicate, false);
  assert.equal(t.ticket_number, 'SI-2026-000101');
  assert.equal(t.status, 'received');
  assert.equal(t.excavator_name, 'Stand-in Excavating Co.');
  assert.equal(t.due_at, '2026-11-03T08:00:00.000Z');

  const [audit] = ticketAudits(db);
  assert.equal(audit.action, 'import');
  assert.equal(audit.actor, FEED_ACTOR);
  assert.equal(JSON.parse(audit.after_json).ticket_number, 'SI-2026-000101');
});

test('every stand-in ticket is valid and imports', () => {
  const db = openDatabase();
  for (const t of loadStandInTickets()) assert.deepEqual(validateIncomingTicket(t), []);
  for (const t of loadStandInTickets()) importLocateTicket(db, t);
  assert.equal(count(db, 'locate_tickets'), 3);
});

test('the same ticket sent twice by the feed makes one ticket and one audit entry', () => {
  const db = openDatabase();
  const first = importLocateTicket(db, sample());
  const again = importLocateTicket(db, sample());
  assert.equal(again.duplicate, true);
  assert.equal(again.id, first.id);
  assert.equal(count(db, 'locate_tickets'), 1);
  assert.equal(ticketAudits(db).length, 1);
});

// ---------- failure path: invalid data format ----------

test('a ticket in an invalid format is rejected with every problem listed, and nothing is saved', () => {
  const db = openDatabase();
  const bad = {
    ticket_number: '  ',
    ticket_type: 'whenever',
    excavator: {},
    work_description: '',
    dig_site: { address: 'x', lat: 123 },
    received_at: '2026-10-30T10:00:00Z',
    due_at: '2026-10-29T10:00:00Z',
  };
  assert.throws(() => importLocateTicket(db, bad), (err) => {
    assert.ok(err instanceof ValidationError);
    for (const expected of ['ticket_number is required', 'ticket_type must be one of: normal, emergency', 'excavator.name is required',
      'work_description is required', 'dig_site.lat must be a number from -90 to 90', 'due_at cannot be before received_at']) {
      assert.ok(err.problems.includes(expected), `missing problem: ${expected}`);
    }
    return true;
  });
  assert.throws(() => importLocateTicket(db, 'not an object'), ValidationError);
  assert.throws(() => importLocateTicket(db, { ...sample(), due_at: 'soon' }), /due_at must be an ISO date-time/);
  assert.equal(count(db, 'locate_tickets'), 0);
  assert.equal(ticketAudits(db).length, 0);
});

// ---------- failure path: data entry not found ----------

test('looking up a ticket that does not exist gives a clear "not found"', () => {
  const db = openDatabase();
  assert.throws(() => getLocateTicket(db, 'no-such-ticket'), (err) => err instanceof LocateTicketNotFoundError
    && err instanceof NotFoundError && err.message === 'No locate ticket no-such-ticket');
  assert.equal(findLocateTicketByNumber(db, 'SI-0000'), null);
});

// ---------- update (AC1, AC3) ----------

test('AC1 + AC3: updating a ticket saves the changes accurately and audits who, before and after', async () => {
  const db = openDatabase();
  const t = importLocateTicket(db, sample());
  const wo = await createWorkOrder(db, { title: 'Locate for fence posts', work_type: 'locate', location_text: t.dig_address, created_by: 'locator-1' });

  const updated = updateLocateTicket(db, t.id, {
    status: 'in_progress',
    locator_notes: 'Water main runs along the back line',
    marking_details: 'Blue paint and flags, 3 m either side',
    work_order_id: wo.id,
  }, { actor: 'locator-1' });

  // AC1: the system reflects the changes accurately
  const stored = getLocateTicket(db, t.id);
  assert.equal(stored.status, 'in_progress');
  assert.equal(stored.locator_notes, 'Water main runs along the back line');
  assert.equal(stored.marking_details, 'Blue paint and flags, 3 m either side');
  assert.equal(stored.work_order_id, wo.id);
  assert.equal(stored.ticket_number, t.ticket_number, 'fields not in the update are unchanged');
  assert.deepEqual(updated, stored);

  // AC3: the change is in the audit trail
  const audit = ticketAudits(db).find((a) => a.action === 'update');
  assert.equal(audit.actor, 'locator-1');
  assert.equal(JSON.parse(audit.before_json).status, 'received');
  assert.equal(JSON.parse(audit.after_json).marking_details, 'Blue paint and flags, 3 m either side');
});

test('updating a ticket that does not exist is refused and nothing is audited', () => {
  const db = openDatabase();
  assert.throws(() => updateLocateTicket(db, 'no-such-ticket', { locator_notes: 'x' }, { actor: 'locator-1' }), LocateTicketNotFoundError);
  assert.equal(ticketAudits(db).length, 0);
});

test('an update in an invalid format is refused, every problem is listed, and nothing changes', () => {
  const db = openDatabase();
  const { duplicate: _d, ...original } = importLocateTicket(db, sample());
  assert.throws(() => updateLocateTicket(db, original.id, {
    response_code: 'marked', status: 'completed', locator_notes: 42, work_order_id: 'no-such-work-order',
  }, { actor: 'locator-1' }), (err) => {
    assert.ok(err instanceof ValidationError);
    assert.ok(err.problems.includes('response_code cannot be changed by an update'));
    assert.ok(err.problems.some((p) => p.startsWith('status can only be set to in_progress')));
    assert.ok(err.problems.includes('locator_notes must be text or null'));
    assert.ok(err.problems.includes('work order no-such-work-order does not exist'));
    return true;
  });
  assert.throws(() => updateLocateTicket(db, original.id, 'nope', { actor: 'locator-1' }), ValidationError);
  assert.throws(() => updateLocateTicket(db, original.id, { locator_notes: 'x' }, {}), /actor is required/);
  assert.deepEqual({ ...getLocateTicket(db, original.id) }, original, 'the ticket is exactly as imported');
  assert.equal(ticketAudits(db).length, 1, 'only the import');
});

test('if the audit entry cannot be written, the update is rolled back', () => {
  const db = openDatabase();
  const t = importLocateTicket(db, sample());
  const failingAudit = () => { throw new Error('audit store unavailable'); };
  assert.throws(() => updateLocateTicket(db, t.id, { locator_notes: 'x' }, { actor: 'locator-1', audit: failingAudit }), /audit store unavailable/);
  assert.equal(getLocateTicket(db, t.id).locator_notes, null);
});

test('an update that changes nothing saves and audits nothing', () => {
  const db = openDatabase();
  const t = importLocateTicket(db, sample());
  updateLocateTicket(db, t.id, { locator_notes: 'Same note' }, { actor: 'locator-1' });
  updateLocateTicket(db, t.id, { locator_notes: 'Same note' }, { actor: 'locator-1' });
  assert.equal(ticketAudits(db).filter((a) => a.action === 'update').length, 1);
});

test('a completed ticket cannot be changed', () => {
  const db = openDatabase();
  const t = importLocateTicket(db, sample());
  db.prepare("UPDATE locate_tickets SET status = 'completed' WHERE id = ?").run(t.id); // completion itself comes in a later step
  assert.throws(() => updateLocateTicket(db, t.id, { locator_notes: 'late note' }, { actor: 'locator-1' }), ConflictError);
});

// ---------- respond ----------

test('responding records the answer, audits it, and delivers it to the one-call centre', async () => {
  const db = openDatabase();
  const { backend, bluestakes } = oneCallCentre(db);
  const t = importLocateTicket(db, sample());
  const r = await respondToLocateTicket(db, t.id, { code: 'marked', note: 'Water main marked in blue', actor: 'locator-1', bluestakes });

  assert.equal(r.status, 'responded');
  assert.equal(r.response_code, 'marked');
  assert.equal(r.response_note, 'Water main marked in blue');
  assert.ok(r.responded_at);
  assert.equal(r.delivery, 'delivered');

  const [sent] = backend.received();
  assert.equal(sent.ticket_number, 'SI-2026-000101');
  assert.equal(sent.response_code, 'marked');

  const audit = ticketAudits(db).find((a) => a.action === 'respond');
  assert.equal(audit.actor, 'locator-1');
  assert.equal(JSON.parse(audit.after_json).response_code, 'marked');

  const log = db.prepare('SELECT * FROM bluestakes_log').all();
  assert.deepEqual(log.map((l) => [l.operation, l.ticket_number, l.outcome]), [['sendResponse', 'SI-2026-000101', 'ok']]);
});

test('a response with an unknown code, or "needs more time" without a note, is refused and nothing changes', async () => {
  const db = openDatabase();
  const t = importLocateTicket(db, sample());
  await assert.rejects(respondToLocateTicket(db, t.id, { code: 'sorted', actor: 'locator-1' }), /code must be one of/);
  await assert.rejects(respondToLocateTicket(db, t.id, { code: 'needs_more_time', actor: 'locator-1' }), /a note is required/);
  await assert.rejects(respondToLocateTicket(db, t.id, { code: 'marked' }), /actor is required/);
  assert.equal(getLocateTicket(db, t.id).status, 'received');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bluestakes_outbox').get().n, 0);
});

test('responding to a ticket that does not exist is refused', async () => {
  const db = openDatabase();
  await assert.rejects(respondToLocateTicket(db, 'no-such-ticket', { code: 'marked', actor: 'locator-1' }), LocateTicketNotFoundError);
});

test('if the one-call centre is down, the response is saved, delivery stays pending, and a resend delivers it', async () => {
  const db = openDatabase();
  const real = createStandInBlueStakes();
  let down = true;
  const flaky = { kind: 'stand-in', sendResponse: (...a) => (down ? Promise.reject(new Error('one-call centre unavailable')) : real.sendResponse(...a)) };
  const { bluestakes } = oneCallCentre(db, flaky);
  const t = importLocateTicket(db, sample());

  const r = await respondToLocateTicket(db, t.id, { code: 'clear_no_conflict', actor: 'locator-1', bluestakes });
  assert.equal(r.status, 'responded', 'the response is not lost');
  assert.equal(r.delivery, 'pending');
  assert.match(r.delivery_failures[0].error, /unavailable/);
  assert.deepEqual(db.prepare('SELECT outcome FROM bluestakes_log').all().map((l) => l.outcome), ['error', 'error'], 'both attempts logged');

  down = false;
  assert.deepEqual(await deliverPendingResponses(db, bluestakes, t.id), []);
  assert.equal(real.received().length, 1);
});

test('delivering again never sends a delivered response twice', async () => {
  const db = openDatabase();
  const { backend, bluestakes } = oneCallCentre(db);
  const t = importLocateTicket(db, sample());
  await respondToLocateTicket(db, t.id, { code: 'marked', actor: 'locator-1', bluestakes });
  await deliverPendingResponses(db, bluestakes, t.id);
  db.prepare("UPDATE bluestakes_outbox SET status = 'pending'").run(); // force a re-send of the same response
  await deliverPendingResponses(db, bluestakes, t.id);
  assert.equal(backend.received().length, 1, 'the centre stores it once (response_id)');
});

test('a ticket can be answered again before completion — "needs more time", then "marked"', async () => {
  const db = openDatabase();
  const { backend, bluestakes } = oneCallCentre(db);
  const t = importLocateTicket(db, sample());
  await respondToLocateTicket(db, t.id, { code: 'needs_more_time', note: 'Crew on an emergency', actor: 'locator-1', bluestakes });
  const r = await respondToLocateTicket(db, t.id, { code: 'marked', actor: 'locator-1', bluestakes });
  assert.equal(r.response_code, 'marked');
  assert.deepEqual(backend.received().map((x) => x.response_code), ['needs_more_time', 'marked']);
  assert.equal(ticketAudits(db).filter((a) => a.action === 'respond').length, 2);
});

// ---------- complete (AC2) ----------

test('AC2: marking an answered ticket complete sets its status to completed, and it is audited', async () => {
  const db = openDatabase();
  const { bluestakes } = oneCallCentre(db);
  const t = importLocateTicket(db, sample());
  await respondToLocateTicket(db, t.id, { code: 'marked', actor: 'locator-1', bluestakes });

  const done = completeLocateTicket(db, t.id, { actor: 'locator-1' });
  assert.equal(done.status, 'completed');
  assert.ok(done.completed_at);
  assert.equal(getLocateTicket(db, t.id).status, 'completed');

  const audit = ticketAudits(db).find((a) => a.action === 'complete');
  assert.equal(audit.actor, 'locator-1');
  assert.equal(JSON.parse(audit.before_json).status, 'responded');
  assert.equal(JSON.parse(audit.after_json).status, 'completed');
});

test('a ticket cannot be completed before the one-call centre has been told it is done', async () => {
  const db = openDatabase();
  const t = importLocateTicket(db, sample());
  assert.throws(() => completeLocateTicket(db, t.id, { actor: 'locator-1' }), /Respond to the one-call centre/);

  // answered, but the answer never arrived
  await respondToLocateTicket(db, t.id, { code: 'marked', actor: 'locator-1' }); // no client: delivery stays pending
  assert.throws(() => completeLocateTicket(db, t.id, { actor: 'locator-1' }), /has not reached the one-call centre/);

  // delivered, but it only asked for more time
  const { bluestakes } = oneCallCentre(db);
  await respondToLocateTicket(db, t.id, { code: 'needs_more_time', note: 'Waiting on crew', actor: 'locator-1', bluestakes });
  assert.throws(() => completeLocateTicket(db, t.id, { actor: 'locator-1' }), /asked for more time/);

  assert.equal(getLocateTicket(db, t.id).status, 'responded');
  assert.equal(ticketAudits(db).filter((a) => a.action === 'complete').length, 0);
});

test('completing twice, completing an unknown ticket, or completing without an actor is refused', async () => {
  const db = openDatabase();
  const { bluestakes } = oneCallCentre(db);
  const t = importLocateTicket(db, sample());
  await respondToLocateTicket(db, t.id, { code: 'clear_no_conflict', actor: 'locator-1', bluestakes });
  completeLocateTicket(db, t.id, { actor: 'locator-1' });

  assert.throws(() => completeLocateTicket(db, t.id, { actor: 'locator-1' }), /already completed/);
  assert.throws(() => completeLocateTicket(db, 'no-such-ticket', { actor: 'locator-1' }), LocateTicketNotFoundError);
  assert.throws(() => completeLocateTicket(db, t.id, {}), /actor is required/);
  assert.equal(ticketAudits(db).filter((a) => a.action === 'complete').length, 1);
});

test('a completed ticket is locked: no more updates or responses', async () => {
  const db = openDatabase();
  const { bluestakes } = oneCallCentre(db);
  const t = importLocateTicket(db, sample());
  await respondToLocateTicket(db, t.id, { code: 'marked', actor: 'locator-1', bluestakes });
  completeLocateTicket(db, t.id, { actor: 'locator-1' });
  assert.throws(() => updateLocateTicket(db, t.id, { locator_notes: 'x' }, { actor: 'locator-1' }), ConflictError);
  await assert.rejects(respondToLocateTicket(db, t.id, { code: 'marked', actor: 'locator-1', bluestakes }), ConflictError);
});

test('if the audit entry cannot be written, completion is rolled back', async () => {
  const db = openDatabase();
  const { bluestakes } = oneCallCentre(db);
  const t = importLocateTicket(db, sample());
  await respondToLocateTicket(db, t.id, { code: 'marked', actor: 'locator-1', bluestakes });
  const failingAudit = () => { throw new Error('audit store unavailable'); };
  assert.throws(() => completeLocateTicket(db, t.id, { actor: 'locator-1', audit: failingAudit }), /audit store unavailable/);
  assert.equal(getLocateTicket(db, t.id).status, 'responded');
});
