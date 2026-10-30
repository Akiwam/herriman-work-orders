// Utility locate tickets from Blue Stakes of Utah, the one-call ("call before you dig") centre (STORY-013, REQ-039).
//
// A ticket arrives from the one-call centre, a city locator works it (update), answers the centre
// (respond), and closes it (complete). Every change is audited in the same transaction as the change.
//
// There is no access to Blue Stakes yet: tickets come from a stand-in feed
// (server/bluestakes/stand-in-tickets.json) and responses go to a stand-in client.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inTransaction } from './db.js';
import { writeAudit, getWorkOrder, ValidationError, NotFoundError, ConflictError } from './workOrders.js';

export const FEED_ACTOR = 'bluestakes-feed';
const TICKET_TYPES = ['normal', 'emergency'];
const defaultNow = () => new Date().toISOString();

export class LocateTicketNotFoundError extends NotFoundError {
  constructor(id) {
    super(id);
    this.name = 'LocateTicketNotFoundError';
    this.message = `No locate ticket ${id}`;
  }
}

const isBlank = (v) => typeof v !== 'string' || v.trim() === '';
const isIsoTime = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const inRange = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/** Problems with a ticket as the feed delivered it; an empty list means it can be imported. */
export function validateIncomingTicket(t) {
  if (t === null || typeof t !== 'object' || Array.isArray(t)) return ['ticket must be an object'];
  const problems = [];
  if (isBlank(t.ticket_number)) problems.push('ticket_number is required');
  if (!TICKET_TYPES.includes(t.ticket_type)) problems.push(`ticket_type must be one of: ${TICKET_TYPES.join(', ')}`);
  if (isBlank(t.excavator?.name)) problems.push('excavator.name is required');
  if (isBlank(t.work_description)) problems.push('work_description is required');
  if (isBlank(t.dig_site?.address)) problems.push('dig_site.address is required');
  const { lat, lng } = t.dig_site ?? {};
  if (lat !== undefined && lat !== null && !inRange(lat, -90, 90)) problems.push('dig_site.lat must be a number from -90 to 90');
  if (lng !== undefined && lng !== null && !inRange(lng, -180, 180)) problems.push('dig_site.lng must be a number from -180 to 180');
  if (!isIsoTime(t.received_at)) problems.push('received_at must be an ISO date-time');
  if (!isIsoTime(t.due_at)) problems.push('due_at must be an ISO date-time');
  if (isIsoTime(t.received_at) && isIsoTime(t.due_at) && Date.parse(t.due_at) < Date.parse(t.received_at)) {
    problems.push('due_at cannot be before received_at');
  }
  return problems;
}

export function getLocateTicket(db, id) {
  const row = db.prepare('SELECT * FROM locate_tickets WHERE id = ?').get(String(id ?? ''));
  if (!row) throw new LocateTicketNotFoundError(id);
  return row;
}

export function findLocateTicketByNumber(db, ticketNumber) {
  return db.prepare('SELECT * FROM locate_tickets WHERE ticket_number = ?').get(String(ticketNumber ?? '').trim()) ?? null;
}

/**
 * Bring a ticket in from the one-call centre's feed. A ticket with missing or invalid fields is
 * rejected (ValidationError) and nothing is saved. Importing a ticket number that already exists
 * returns the existing ticket with duplicate: true and writes nothing — feeds re-send tickets.
 */
export function importLocateTicket(db, incoming, { now = defaultNow } = {}) {
  const problems = validateIncomingTicket(incoming);
  if (problems.length) throw new ValidationError(problems);

  const existing = findLocateTicketByNumber(db, incoming.ticket_number);
  if (existing) return { ...existing, duplicate: true };

  const at = now();
  const row = {
    id: randomUUID(),
    ticket_number: incoming.ticket_number.trim(),
    ticket_type: incoming.ticket_type,
    status: 'received',
    excavator_name: incoming.excavator.name.trim(),
    work_description: incoming.work_description.trim(),
    dig_address: incoming.dig_site.address.trim(),
    latitude: incoming.dig_site.lat ?? null,
    longitude: incoming.dig_site.lng ?? null,
    received_at: new Date(incoming.received_at).toISOString(),
    due_at: new Date(incoming.due_at).toISOString(),
    locator_notes: null,
    marking_details: null,
    work_order_id: null,
    response_code: null,
    response_note: null,
    responded_at: null,
    completed_at: null,
    created_at: at,
    updated_at: at,
  };

  return inTransaction(db, () => {
    // Re-check inside the transaction in case the same ticket raced in twice.
    const raced = findLocateTicketByNumber(db, row.ticket_number);
    if (raced) return { ...raced, duplicate: true };
    db.prepare(`
      INSERT INTO locate_tickets (id, ticket_number, ticket_type, status, excavator_name, work_description, dig_address,
        latitude, longitude, received_at, due_at, locator_notes, marking_details, work_order_id, response_code,
        response_note, responded_at, completed_at, created_at, updated_at)
      VALUES (:id, :ticket_number, :ticket_type, :status, :excavator_name, :work_description, :dig_address,
        :latitude, :longitude, :received_at, :due_at, :locator_notes, :marking_details, :work_order_id, :response_code,
        :response_note, :responded_at, :completed_at, :created_at, :updated_at)`).run(row);
    writeAudit(db, { entityType: 'locate_ticket', entityId: row.id, action: 'import', actor: FEED_ACTOR, after: row, at });
    return { ...getLocateTicket(db, row.id), duplicate: false };
  });
}

export function loadStandInTickets(path = new URL('./bluestakes/stand-in-tickets.json', import.meta.url)) {
  return JSON.parse(readFileSync(path, 'utf8')).tickets;
}

// ---------- update ----------

// What a locator may change while working a ticket. The response and completion have their own actions.
const UPDATABLE = ['locator_notes', 'marking_details', 'work_order_id', 'status'];

function cleanTicketChanges(db, ticket, changes) {
  if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) throw new ValidationError(['changes must be an object']);
  const problems = [];
  const clean = {};
  for (const [field, value] of Object.entries(changes)) {
    if (!UPDATABLE.includes(field)) {
      problems.push(`${field} cannot be changed by an update`);
      continue;
    }
    if (value !== null && typeof value !== 'string') {
      problems.push(`${field} must be text or null`);
      continue;
    }
    const text = value === null ? null : (value.trim() || null);
    if (field === 'status') {
      if (text !== 'in_progress') problems.push('status can only be set to in_progress by an update; use respond or complete');
      else if (!['received', 'in_progress'].includes(ticket.status)) problems.push(`a ${ticket.status} ticket cannot go back to in_progress`);
    }
    if (field === 'work_order_id' && text !== null && !getWorkOrder(db, text)) problems.push(`work order ${text} does not exist`);
    clean[field] = text;
  }
  if (problems.length) throw new ValidationError(problems);
  return clean;
}

/**
 * Change the working details of a ticket. The change and its audit entry (who, before, after)
 * are saved together or not at all. A completed ticket cannot be changed (ConflictError).
 *
 * `audit` is only replaceable so tests can prove the rollback.
 */
export function updateLocateTicket(db, id, changes, { actor, now = defaultNow, audit = writeAudit } = {}) {
  if (isBlank(actor)) throw new ValidationError(['actor is required']);
  return inTransaction(db, () => {
    const before = getLocateTicket(db, id);
    if (before.status === 'completed') throw new ConflictError('A completed locate ticket cannot be changed.');
    const clean = cleanTicketChanges(db, before, changes);

    const changed = Object.keys(clean).filter((f) => clean[f] !== before[f]);
    if (changed.length === 0) return before; // nothing changed: nothing to save or audit

    const at = now();
    const sets = changed.map((f) => `${f} = :${f}`).join(', ');
    db.prepare(`UPDATE locate_tickets SET ${sets}, updated_at = :updated_at WHERE id = :id`)
      .run({ ...Object.fromEntries(changed.map((f) => [f, clean[f]])), updated_at: at, id: before.id });
    const after = getLocateTicket(db, before.id);
    audit(db, { entityType: 'locate_ticket', entityId: before.id, action: 'update', actor: actor.trim(), before, after, at });
    return after;
  });
}

// ---------- respond ----------

// PLACEHOLDER codes: the real one-call centre response codes are not known yet. Replace this list
// with Blue Stakes' official codes once the city has access; nothing else needs to change.
export const RESPONSE_CODES = {
  marked: 'Facilities located and marked',
  clear_no_conflict: 'No city facilities in the dig area',
  needs_more_time: 'Locate not finished by the due time; more time needed',
};

/** Where delivery stands: 'delivered' when every queued response has reached the centre, 'pending' otherwise. */
export function deliveryStatus(db, ticketId) {
  const rows = db.prepare('SELECT status FROM bluestakes_outbox WHERE ticket_id = ?').all(ticketId);
  if (!rows.length) return 'none';
  return rows.every((r) => r.status === 'delivered') ? 'delivered' : 'pending';
}

/**
 * Send every undelivered response for a ticket to the one-call centre. Safe to run any number of
 * times: a delivered response is never sent again, and response_id stops the centre storing it twice.
 */
export async function deliverPendingResponses(db, bluestakes, ticketId, { now = defaultNow } = {}) {
  const ticket = getLocateTicket(db, ticketId);
  const rows = db.prepare("SELECT * FROM bluestakes_outbox WHERE ticket_id = ? AND status != 'delivered' ORDER BY queued_at").all(ticketId);
  const failures = [];
  for (const row of rows) {
    try {
      await bluestakes.sendResponse(ticket.ticket_number, {
        response_id: row.response_id, response_code: row.response_code, note: row.response_note, responded_at: row.queued_at,
      });
      db.prepare("UPDATE bluestakes_outbox SET status = 'delivered', attempts = attempts + 1, last_error = NULL, delivered_at = ? WHERE response_id = ?")
        .run(now(), row.response_id);
    } catch (err) {
      db.prepare("UPDATE bluestakes_outbox SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE response_id = ?")
        .run(String(err?.message ?? err), row.response_id);
      failures.push({ response_id: row.response_id, error: String(err?.message ?? err) });
    }
  }
  return failures;
}

/**
 * Answer the one-call centre for this ticket. The response is saved, audited and queued for delivery
 * in one transaction, then sent. If the centre cannot be reached, the response is still saved and
 * the delivery stays pending for deliverPendingResponses() to retry.
 *
 * A ticket can be answered again before it is completed (e.g. needs_more_time, then marked).
 */
export async function respondToLocateTicket(db, id, { code, note = null, actor, bluestakes = null, now = defaultNow } = {}) {
  const problems = [];
  if (isBlank(actor)) problems.push('actor is required');
  if (!Object.hasOwn(RESPONSE_CODES, code)) problems.push(`code must be one of: ${Object.keys(RESPONSE_CODES).join(', ')}`);
  if (note !== null && typeof note !== 'string') problems.push('note must be text or null');
  if (code === 'needs_more_time' && isBlank(note)) problems.push('a note is required when more time is needed');
  if (problems.length) throw new ValidationError(problems);

  const responseId = randomUUID();
  const ticketId = inTransaction(db, () => {
    const before = getLocateTicket(db, id);
    if (before.status === 'completed') throw new ConflictError('A completed locate ticket cannot be answered again.');
    const at = now();
    const cleanNote = note === null ? null : (note.trim() || null);
    db.prepare(`UPDATE locate_tickets SET status = 'responded', response_code = ?, response_note = ?, responded_at = ?, updated_at = ?
                WHERE id = ?`).run(code, cleanNote, at, at, before.id);
    db.prepare('INSERT INTO bluestakes_outbox (response_id, ticket_id, response_code, response_note, queued_at) VALUES (?, ?, ?, ?, ?)')
      .run(responseId, before.id, code, cleanNote, at);
    const after = getLocateTicket(db, before.id);
    writeAudit(db, { entityType: 'locate_ticket', entityId: before.id, action: 'respond', actor: actor.trim(), before, after: { ...after, response_id: responseId }, at });
    return before.id;
  });

  const failures = bluestakes ? await deliverPendingResponses(db, bluestakes, ticketId, { now }) : [];
  return { ...getLocateTicket(db, ticketId), delivery: deliveryStatus(db, ticketId), delivery_failures: failures };
}

// ---------- complete ----------

/**
 * Close a ticket: status becomes 'completed', with the time and an audit entry. Refused (ConflictError,
 * nothing changes) unless the one-call centre has been answered and has received that answer, and the
 * answer was not "needs more time" — a ticket is never closed without the centre being told it is done.
 */
export function completeLocateTicket(db, id, { actor, now = defaultNow, audit = writeAudit } = {}) {
  if (isBlank(actor)) throw new ValidationError(['actor is required']);

  return inTransaction(db, () => {
    const before = getLocateTicket(db, id);
    if (before.status === 'completed') throw new ConflictError('This locate ticket is already completed.');
    if (!before.response_code) throw new ConflictError('Respond to the one-call centre before completing the ticket.');
    if (before.response_code === 'needs_more_time') throw new ConflictError('The last response asked for more time; send a final response first.');
    if (deliveryStatus(db, before.id) !== 'delivered') throw new ConflictError('The response has not reached the one-call centre yet; resend it first.');

    const at = now();
    db.prepare("UPDATE locate_tickets SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?").run(at, at, before.id);
    const after = getLocateTicket(db, before.id);
    audit(db, { entityType: 'locate_ticket', entityId: before.id, action: 'complete', actor: actor.trim(), before, after, at });
    return after;
  });
}
