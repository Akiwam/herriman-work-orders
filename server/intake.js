// AI-first intake (STORY-015, REQ-057): the agent does the data entry, a named person keeps the decision.
//
// A citizen request (STORY-003) or a Blue Stakes locate ticket (STORY-013) arrives; the intake agent
// reads it and proposes a draft work order with the fields filled in. Nothing reaches the live work
// order queue until a person approves it (see "the human decision" below). Fields the agent cannot work out are left empty
// and listed with a reason, rather than guessed.
//
// THE AGENT. Until the city or Colaberry provides an AI model, drafting is done by a rule-based
// stand-in, and every draft says so (drafted_by). A real model plugs in as `drafter`: whatever it
// returns is checked against the expected fields, and if it fails, times out or returns something
// unusable, the rule-based stand-in drafts instead and the draft records why.

import { createHash, randomUUID } from 'node:crypto';
import { inTransaction } from './db.js';
import {
  writeAudit, ValidationError, NotFoundError, ConflictError, createWorkOrder, getWorkOrderDetail,
} from './workOrders.js';
import { hasPermission, AccessDeniedError } from './access.js';
import { importLocateTicket } from './locateTickets.js';

export const STANDIN_AGENT = 'intake agent (rule-based stand-in for the AI model)';
export const DRAFT_FIELDS = ['title', 'work_type', 'priority', 'location_text', 'latitude', 'longitude', 'description'];
export const REQUIRED_TO_APPROVE = ['title', 'work_type', 'location_text'];
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const defaultNow = () => new Date().toISOString();

// Work types the agent recognises, and words that point to each. PLACEHOLDER list until the city
// confirms its work types; a request matching none is left for a person to classify.
export const WORK_TYPES = {
  pothole: ['pothole', 'pot hole', 'hole in the road', 'road surface'],
  streetlight: ['streetlight', 'street light', 'light out', 'lamp'],
  water_leak: ['water leak', 'leak', 'burst pipe', 'water main', 'flooding'],
  hydrant: ['hydrant'],
  graffiti: ['graffiti', 'vandal', 'spray paint'],
  sidewalk: ['sidewalk', 'trip hazard', 'curb'],
  sign: ['sign', 'stop sign', 'street sign'],
  tree: ['tree', 'branch', 'limb'],
  stormwater: ['storm drain', 'stormwater', 'drain blocked'],
};
const URGENT_WORDS = ['danger', 'dangerous', 'injur', 'gas', 'live wire', 'sinkhole', 'flooding', 'emergency'];

/** Who performs each kind of work, and who must approve it. PLACEHOLDER until the city confirms. */
export function routeFor(workType) {
  return { performer: 'field_crew', approver: 'supervisor', locate: workType === 'locate' };
}

// ---------- reading the sources ----------

function loadSource(db, sourceType, sourceId) {
  if (sourceType === 'citizen_request') {
    const r = db.prepare('SELECT * FROM service_requests WHERE id = ?').get(String(sourceId ?? ''));
    if (!r) throw Object.assign(new NotFoundError(sourceId), { message: `No citizen request ${sourceId}` });
    // Only what the request says about the problem. The contact details are never given to the agent.
    return { kind: sourceType, id: r.id, reference: r.tracking_code, description: r.description, category: r.category,
      location_text: r.location_text, latitude: r.latitude, longitude: r.longitude };
  }
  if (sourceType === 'locate_ticket') {
    const t = db.prepare('SELECT * FROM locate_tickets WHERE id = ?').get(String(sourceId ?? ''));
    if (!t) throw Object.assign(new NotFoundError(sourceId), { message: `No locate ticket ${sourceId}` });
    return { kind: sourceType, id: t.id, reference: t.ticket_number, ticket_type: t.ticket_type, excavator_name: t.excavator_name,
      work_description: t.work_description, dig_address: t.dig_address, latitude: t.latitude, longitude: t.longitude, due_at: t.due_at };
  }
  throw new ValidationError(['source type must be citizen_request or locate_ticket']);
}

/** A fingerprint of the source as the agent saw it. If it changes, an approval is refused. */
export const fingerprint = (source) => createHash('sha256').update(JSON.stringify(source)).digest('hex');

// ---------- the rule-based stand-in ----------

const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

// The phrases above are plain lowercase words, so they can go into the pattern as they are.
const mentions = (text, phrase) => new RegExp(`(^|[^a-z])${phrase}`).test(text);

function recogniseWorkType(...texts) {
  const text = texts.filter(Boolean).join(' ').toLowerCase();
  // Whole words only: "street" must not count as "tree".
  const found = Object.entries(WORK_TYPES).filter(([, words]) => words.some((w) => mentions(text, w))).map(([type]) => type);
  return found.length === 1 ? { type: found[0] } : { type: null, why: found.length ? `could match ${found.join(' or ')}` : 'no known work type mentioned' };
}

/** Draft from a source. Returns { fields, undetermined: [{ field, reason }] }. Never guesses. */
export function ruleBasedDrafter(source) {
  const undetermined = [];
  if (source.kind === 'locate_ticket') {
    const location = clean(source.dig_address);
    if (!location) undetermined.push({ field: 'location_text', reason: 'the ticket has no dig address' });
    return {
      fields: {
        title: `Locate and mark utilities: Blue Stakes ticket ${source.reference}`,
        work_type: 'locate',
        priority: source.ticket_type === 'emergency' ? 'urgent' : 'normal',
        location_text: location,
        latitude: source.latitude ?? null,
        longitude: source.longitude ?? null,
        description: `${source.excavator_name} plans: ${source.work_description}. Response due to Blue Stakes by ${source.due_at}.`,
      },
      undetermined,
    };
  }
  // A citizen request: the category if it names a known type, otherwise the description.
  const category = clean(source.category)?.toLowerCase().replace(/[\s-]+/g, '_');
  const byCategory = category && Object.hasOwn(WORK_TYPES, category) ? { type: category } : null;
  const recognised = byCategory ?? recogniseWorkType(source.category, source.description);
  if (!recognised.type) undetermined.push({ field: 'work_type', reason: `could not tell the work type from the request: ${recognised.why}` });
  const text = `${source.description ?? ''}`.toLowerCase();
  const urgent = URGENT_WORDS.find((w) => mentions(text, w));
  const summary = clean(source.description)?.replace(/\s+/g, ' ') ?? '';
  const label = recognised.type ? recognised.type.replace('_', ' ') : 'Citizen request';
  const location = clean(source.location_text);
  if (!location && source.latitude == null) undetermined.push({ field: 'location_text', reason: 'the request gives no location' });
  return {
    fields: {
      title: `${label[0].toUpperCase()}${label.slice(1)}: ${summary.length > 60 ? `${summary.slice(0, 57)}…` : summary}`,
      work_type: recognised.type,
      priority: urgent ? 'high' : 'normal',
      location_text: location,
      latitude: source.latitude ?? null,
      longitude: source.longitude ?? null,
      description: `Citizen request ${source.reference}: ${summary}${urgent ? ` (raised to high: mentions "${urgent}")` : ''}`,
    },
    undetermined,
  };
}

/** Problems with what a drafter returned; an empty list means it can be used. */
export function checkDraft(out) {
  if (!out || typeof out !== 'object' || !out.fields || typeof out.fields !== 'object') return ['the drafter returned no fields'];
  const problems = [];
  for (const f of Object.keys(out.fields)) if (!DRAFT_FIELDS.includes(f)) problems.push(`${f} is not a draft field`);
  for (const f of ['title', 'work_type', 'location_text', 'description']) {
    if (out.fields[f] !== null && out.fields[f] !== undefined && typeof out.fields[f] !== 'string') problems.push(`${f} must be text or empty`);
  }
  if (out.fields.priority !== undefined && out.fields.priority !== null && !PRIORITIES.includes(out.fields.priority)) problems.push(`priority must be one of ${PRIORITIES.join(', ')}`);
  for (const f of ['latitude', 'longitude']) {
    if (out.fields[f] !== null && out.fields[f] !== undefined && typeof out.fields[f] !== 'number') problems.push(`${f} must be a number or empty`);
  }
  if (!Array.isArray(out.undetermined)) problems.push('undetermined must be a list');
  return problems;
}

/**
 * Run the drafter, falling back to the rule-based stand-in if it fails or returns something unusable.
 * Any field left empty that a work order needs is listed as undetermined, whatever the drafter said.
 */
async function draftWith(drafter, source, agentName) {
  let out;
  let agent = agentName;
  let fallbackReason = null;
  if (drafter) {
    try {
      out = await drafter(source);
      const problems = checkDraft(out);
      if (problems.length) throw new Error(`unusable draft: ${problems.join('; ')}`);
    } catch (err) {
      fallbackReason = `${agentName} could not draft (${String(err.message ?? err).slice(0, 200)}); the rule-based stand-in drafted instead`;
      out = null;
    }
  }
  if (!out) {
    out = ruleBasedDrafter(source);
    agent = STANDIN_AGENT;
  }
  const fields = Object.fromEntries(DRAFT_FIELDS.map((f) => [f, out.fields[f] ?? null]));
  fields.priority = fields.priority ?? 'normal';
  const undetermined = [...out.undetermined];
  for (const f of REQUIRED_TO_APPROVE) {
    if (!fields[f] && !undetermined.some((u) => u.field === f)) undetermined.push({ field: f, reason: 'left empty by the agent' });
  }
  return { fields, undetermined, agent, fallbackReason };
}

// ---------- proposing ----------

const draftView = (row) => ({
  id: row.id, source_type: row.source_type, source_id: row.source_id, status: row.status, version: row.version,
  proposed: JSON.parse(row.proposed_json), undetermined: JSON.parse(row.undetermined_json),
  drafted_by: row.drafted_by, drafted_at: row.drafted_at, performer: row.performer, approver: row.approver,
  final: row.final_json ? JSON.parse(row.final_json) : null, reviewed_by: row.reviewed_by, reviewed_at: row.reviewed_at,
  review_note: row.review_note, work_order_id: row.work_order_id,
});

export function getDraft(db, id) {
  const row = db.prepare('SELECT * FROM intake_drafts WHERE id = ?').get(String(id ?? ''));
  return row ? draftView(row) : null;
}

export const listDrafts = (db, { status = 'proposed' } = {}) => db.prepare('SELECT * FROM intake_drafts WHERE status = ? ORDER BY drafted_at, id').all(status).map(draftView);

/**
 * The agent proposes a draft work order for a source record. Safe to repeat: if an open draft already
 * exists for the source as it is now, that draft is returned (duplicate: true) and nothing is written.
 * If the source changed since its open draft, the old draft is marked superseded (kept, not deleted)
 * and a new one is proposed. Saved with its audit entry, or not at all.
 *
 * `drafter` is an optional AI model function (source → { fields, undetermined }); see the file header.
 */
export async function proposeDraft(db, { sourceType, sourceId }, { drafter = null, agentName = 'AI model', now = defaultNow, audit = writeAudit } = {}) {
  const source = loadSource(db, sourceType, sourceId);
  const print = fingerprint(source);
  const open = db.prepare("SELECT * FROM intake_drafts WHERE source_type = ? AND source_id = ? AND status = 'proposed'").get(sourceType, source.id);
  if (open && open.source_fingerprint === print) return { ...draftView(open), duplicate: true };

  const { fields, undetermined, agent, fallbackReason } = await draftWith(drafter, source, agentName);
  const route = routeFor(fields.work_type);
  const id = randomUUID();
  const at = now();
  inTransaction(db, () => {
    const stillOpen = db.prepare("SELECT * FROM intake_drafts WHERE source_type = ? AND source_id = ? AND status = 'proposed'").get(sourceType, source.id);
    if (stillOpen?.source_fingerprint === print) return; // another call proposed it meanwhile
    if (stillOpen) {
      db.prepare("UPDATE intake_drafts SET status = 'superseded', version = version + 1 WHERE id = ?").run(stillOpen.id);
      audit(db, { entityType: 'intake_draft', entityId: stillOpen.id, action: 'supersede', actor: agent, after: { reason: 'the source changed', replaced_by: id }, at });
    }
    db.prepare(`INSERT INTO intake_drafts (id, source_type, source_id, source_fingerprint, status, version, proposed_json, undetermined_json,
                drafted_by, drafted_at, performer, approver) VALUES (?, ?, ?, ?, 'proposed', 1, ?, ?, ?, ?, ?, ?)`)
      .run(id, sourceType, source.id, print, JSON.stringify(fields), JSON.stringify(undetermined), agent, at, route.performer, route.approver);
    audit(db, {
      entityType: 'intake_draft', entityId: id, action: 'propose', actor: agent,
      after: { source_type: sourceType, source_id: source.id, fields, undetermined, ...(fallbackReason ? { fallback: fallbackReason } : {}) }, at,
    });
  });
  const saved = getDraft(db, id) ?? draftView(db.prepare("SELECT * FROM intake_drafts WHERE source_type = ? AND source_id = ? AND status = 'proposed'").get(sourceType, source.id));
  return { ...saved, duplicate: saved.id !== id, fallback: fallbackReason };
}

// ---------- the human decision ----------
//
// A named person with intake:approve approves, corrects or rejects each draft. The agent's proposal is
// never changed; the reviewer's version is stored separately and is what becomes the work order.

export const INTAKE_APPROVE = 'intake:approve';

/** A ConflictError with a name the API can recognise (made by a function: see access.js on circular imports). */
function conflict(name, message, extra = {}) {
  return Object.assign(new ConflictError(message), { name, ...extra });
}

function reviewer(db, actorUserId) {
  if (!hasPermission(db, actorUserId, INTAKE_APPROVE)) throw new AccessDeniedError(INTAKE_APPROVE);
  return db.prepare('SELECT id, email, display_name FROM users WHERE id = ?').get(actorUserId);
}

const nameOf = (db, userId) => db.prepare('SELECT display_name FROM users WHERE id = ?').get(userId)?.display_name ?? userId;

/** The draft, ready to be decided on: still proposed, the version the reviewer saw, and its source unchanged. */
function decidable(db, id, actorUserId, expectedVersion) {
  const row = db.prepare('SELECT * FROM intake_drafts WHERE id = ?').get(String(id ?? ''));
  if (!row) throw Object.assign(new NotFoundError(id), { message: `No intake draft ${id}` });
  if (row.status === 'approved' || row.status === 'rejected') {
    throw conflict('DraftAlreadyDecided', `Already ${row.status} by ${nameOf(db, row.reviewed_by)} at ${row.reviewed_at}.`, { decidedBy: row.reviewed_by, status: row.status });
  }
  if (row.status === 'approving') throw conflict('DraftAlreadyDecided', `${nameOf(db, row.reviewed_by)} is approving this right now.`, { decidedBy: row.reviewed_by, status: row.status });
  if (row.status === 'superseded') throw conflict('DraftSuperseded', 'This draft was replaced by a newer one, because its source changed. Open the newer draft.');
  if (expectedVersion !== undefined && row.version !== expectedVersion) {
    throw conflict('DraftVersionConflict', `This draft changed since you opened it (you had version ${expectedVersion}, it is now version ${row.version}). Reload it.`, { currentVersion: row.version });
  }
  if (fingerprint(loadSource(db, row.source_type, row.source_id)) !== row.source_fingerprint) {
    throw conflict('SourceChanged', 'The source record changed after this was drafted, so it cannot be approved as it is. Re-draft it from the source.');
  }
  return row;
}

/** The proposal with the reviewer's changes applied, checked; every undetermined field must now be filled. */
function reviewerVersion(row, changes) {
  const problems = Object.keys(changes ?? {}).filter((f) => !DRAFT_FIELDS.includes(f)).map((f) => `${f} is not a draft field`);
  const merged = { ...JSON.parse(row.final_json ?? row.proposed_json), ...Object.fromEntries(Object.entries(changes ?? {}).filter(([f]) => DRAFT_FIELDS.includes(f))) };
  for (const f of REQUIRED_TO_APPROVE) if (typeof merged[f] !== 'string' || !merged[f].trim()) problems.push(`${f} must be filled in before approving`);
  if (!PRIORITIES.includes(merged.priority)) problems.push(`priority must be one of ${PRIORITIES.join(', ')}`);
  for (const f of ['latitude', 'longitude']) if (merged[f] !== null && merged[f] !== undefined && typeof merged[f] !== 'number') problems.push(`${f} must be a number or empty`);
  return { merged, problems };
}

const changedFields = (proposed, final) => DRAFT_FIELDS.filter((f) => (proposed[f] ?? null) !== (final[f] ?? null));

/**
 * Save a correction without deciding yet: the reviewer's version is stored, the proposal is kept,
 * and the draft stays in the queue. Audited.
 */
export function correctDraft(db, id, { changes, actorUserId, expectedVersion, now = defaultNow, audit = writeAudit } = {}) {
  const who = reviewer(db, actorUserId);
  return inTransaction(db, () => {
    const row = decidable(db, id, actorUserId, expectedVersion);
    const { merged } = reviewerVersion(row, changes);
    const unknown = Object.keys(changes ?? {}).filter((f) => !DRAFT_FIELDS.includes(f));
    if (unknown.length) throw new ValidationError(unknown.map((f) => `${f} is not a draft field`));
    const at = now();
    db.prepare('UPDATE intake_drafts SET final_json = ?, version = version + 1 WHERE id = ?').run(JSON.stringify(merged), row.id);
    audit(db, { entityType: 'intake_draft', entityId: row.id, action: 'correct', actor: who.email, actorUserId: who.id, after: { changed: changedFields(JSON.parse(row.proposed_json), merged), version: row.version + 1 }, at });
    return getDraft(db, row.id);
  });
}

/**
 * Approve a draft, optionally with corrections. The work order is created from the reviewer's version,
 * and the draft and the work order's history both name who approved it.
 *
 * - Two reviewers at once: the first claims the draft; the second is told who did. The same person
 *   approving twice (a double-click) gets the same work order back (duplicate: true).
 * - The source changed since drafting, or the draft changed since the reviewer opened it: refused.
 * - The work order's request_id comes from the draft id, so it can never be created twice.
 */
export async function approveDraft(db, id, { changes = {}, actorUserId, expectedVersion, now = defaultNow, audit = writeAudit } = {}) {
  const who = reviewer(db, actorUserId);
  let claimed;
  try {
    claimed = inTransaction(db, () => {
      const row = decidable(db, id, actorUserId, expectedVersion);
      const { merged, problems } = reviewerVersion(row, changes);
      if (problems.length) throw new ValidationError(problems);
      db.prepare("UPDATE intake_drafts SET status = 'approving', reviewed_by = ?, final_json = ?, version = version + 1 WHERE id = ?")
        .run(who.id, JSON.stringify(merged), row.id);
      return { row, final: merged };
    });
  } catch (err) {
    // The same person approving again (a double-click) is not an error: hand back what they made.
    const row = db.prepare('SELECT * FROM intake_drafts WHERE id = ?').get(String(id ?? ''));
    if (err.name === 'DraftAlreadyDecided' && row?.status === 'approved' && row.reviewed_by === who.id) {
      return { draft: getDraft(db, row.id), workOrder: getWorkOrderDetail(db, row.work_order_id), duplicate: true };
    }
    throw err;
  }

  const { row, final } = claimed;
  let workOrder;
  try {
    workOrder = await createWorkOrder(db, {
      request_id: `intake:${row.id}`,
      title: final.title, description: final.description, work_type: final.work_type, priority: final.priority,
      location_text: final.location_text, created_by: who.email,
    }, { now });
  } catch (err) {
    // Release the claim so the draft can be approved again once the problem is fixed.
    db.prepare("UPDATE intake_drafts SET status = 'proposed', reviewed_by = NULL, version = version + 1 WHERE id = ? AND status = 'approving'").run(row.id);
    throw err;
  }

  const at = now();
  try {
    recordApproval(db, { row, final, who, workOrder, at, audit });
  } catch (err) {
    // The approval could not be recorded: release the claim. The work order already made is reused
    // on the next approval (same request_id), never duplicated.
    db.prepare("UPDATE intake_drafts SET status = 'proposed', reviewed_by = NULL, version = version + 1 WHERE id = ? AND status = 'approving'").run(row.id);
    throw err;
  }
  return { draft: getDraft(db, row.id), workOrder: getWorkOrderDetail(db, workOrder.id), duplicate: false };
}

/** Mark the draft approved, link its source to the work order, and audit both — together or not at all. */
function recordApproval(db, { row, final, who, workOrder, at, audit }) {
  inTransaction(db, () => {
    db.prepare("UPDATE intake_drafts SET status = 'approved', reviewed_at = ?, work_order_id = ?, version = version + 1 WHERE id = ?").run(at, workOrder.id, row.id);
    if (row.source_type === 'citizen_request') db.prepare('UPDATE service_requests SET work_order_id = ? WHERE id = ?').run(workOrder.id, row.source_id);
    if (row.source_type === 'locate_ticket') db.prepare('UPDATE locate_tickets SET work_order_id = ? WHERE id = ?').run(workOrder.id, row.source_id);
    const changed = changedFields(JSON.parse(row.proposed_json), final);
    audit(db, {
      entityType: 'intake_draft', entityId: row.id, action: 'approve', actor: who.email, actorUserId: who.id,
      after: { work_order_id: workOrder.id, changed_from_proposal: changed, final }, at,
    });
    audit(db, {
      entityType: 'work_order', entityId: workOrder.id, action: 'intake_approve', actor: who.email, actorUserId: who.id,
      after: { draft_id: row.id, drafted_by: row.drafted_by, approved_by: who.display_name, source_type: row.source_type, changed_from_proposal: changed }, at,
    });
  });
}

/** Reject a draft, with the reason. Nothing reaches the live queue; the proposal and the decision are kept. */
export function rejectDraft(db, id, { reason, actorUserId, expectedVersion, now = defaultNow, audit = writeAudit } = {}) {
  const who = reviewer(db, actorUserId);
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (why.length < 3 || why.length > 1000) throw new ValidationError(['a reason of 3 to 1000 characters is required to reject']);
  return inTransaction(db, () => {
    const row = decidable(db, id, actorUserId, expectedVersion);
    const at = now();
    db.prepare("UPDATE intake_drafts SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ?, version = version + 1 WHERE id = ?").run(who.id, at, why, row.id);
    audit(db, { entityType: 'intake_draft', entityId: row.id, action: 'reject', actor: who.email, actorUserId: who.id, after: { reason: why }, at });
    return getDraft(db, row.id);
  });
}

// ---------- arrivals ----------

/** A Blue Stakes ticket arrives (STORY-013 import) and the agent drafts its work order. Safe to repeat. */
export async function receiveLocateTicket(db, incoming, opts = {}) {
  const ticket = importLocateTicket(db, incoming, opts.now ? { now: opts.now } : {});
  const draft = await proposeDraft(db, { sourceType: 'locate_ticket', sourceId: ticket.id }, opts);
  return { ticket, draft };
}

/**
 * Draft every citizen request and Blue Stakes ticket that has no work order and no draft yet — for
 * catching up if drafting failed when something arrived. Safe to run any number of times.
 */
export async function draftNewArrivals(db, opts = {}) {
  const waiting = [
    ...db.prepare(`SELECT 'citizen_request' AS t, id FROM service_requests r WHERE work_order_id IS NULL
                   AND NOT EXISTS (SELECT 1 FROM intake_drafts d WHERE d.source_type = 'citizen_request' AND d.source_id = r.id)`).all(),
    ...db.prepare(`SELECT 'locate_ticket' AS t, id FROM locate_tickets k WHERE work_order_id IS NULL
                   AND NOT EXISTS (SELECT 1 FROM intake_drafts d WHERE d.source_type = 'locate_ticket' AND d.source_id = k.id)`).all(),
  ];
  const drafted = [];
  for (const w of waiting) drafted.push(await proposeDraft(db, { sourceType: w.t, sourceId: w.id }, opts));
  return drafted;
}
