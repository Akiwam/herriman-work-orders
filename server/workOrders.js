// Work order actions.
//
// Every action writes its audit entry in the same transaction as the change, so a change
// can never exist without its audit record.
//
// GIS (REQ-023) works in three phases:
//   1. before the transaction: look up the selected assets (with timeout + retries) and autofill
//   2. inside the transaction: save the work order, its asset snapshot, its audit entry, and a
//      'pending' gis_sync row per asset
//   3. after the transaction: push the work order to each asset in GIS and mark the row done.
//      If GIS is down, the work order is still saved and the row stays retryable (syncPending).

import { randomUUID } from 'node:crypto';
import { inTransaction } from './db.js';

export class NotFoundError extends Error {
  constructor(id) {
    super(`No work order with id ${id}`);
    this.name = 'NotFoundError';
    this.id = id;
  }
}

/** The action is valid in general but not for this work order's current state. */
export class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class ValidationError extends Error {
  constructor(problems) {
    super(`Work order is missing required data: ${problems.join('; ')}`);
    this.name = 'ValidationError';
    this.problems = problems;
  }
}

const isBlank = (v) => typeof v !== 'string' || v.trim() === '';
const trimOrNull = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const defaultNow = () => new Date().toISOString();

// ---------- audit ----------

export function writeAudit(db, { entityType, entityId, action, actor, before = null, after = null, at }) {
  db.prepare(`
    INSERT INTO audit_entries (entity_type, entity_id, action, actor, before_json, after_json, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(entityType, entityId, action, actor,
    before === null ? null : JSON.stringify(before),
    after === null ? null : JSON.stringify(after),
    at);
}

// ---------- reads ----------

export function getWorkOrder(db, id) {
  return db.prepare('SELECT * FROM work_orders WHERE id = ?').get(id) ?? null;
}

export function getAssets(db, workOrderId) {
  return db.prepare('SELECT * FROM work_order_assets WHERE work_order_id = ? ORDER BY rowid').all(workOrderId)
    .map((a) => ({ ...a, attributes: a.attributes_json ? JSON.parse(a.attributes_json) : null }));
}

/** 'synced' when every asset has received the latest change, 'pending' when any has not, 'none' with no assets. */
export function gisSyncStatus(db, workOrderId) {
  const open = db.prepare("SELECT COUNT(*) AS n FROM gis_sync WHERE work_order_id = ? AND status != 'done'").get(workOrderId).n;
  const any = db.prepare('SELECT COUNT(*) AS n FROM work_order_assets WHERE work_order_id = ?').get(workOrderId).n;
  if (!any) return 'none';
  return open ? 'pending' : 'synced';
}

/** The work order with its assets and GIS sync state — what callers get back from every action. */
export function getWorkOrderDetail(db, id) {
  const row = getWorkOrder(db, id);
  if (!row) return null;
  return { ...row, assets: getAssets(db, id), gis_sync: gisSyncStatus(db, id) };
}

// ---------- GIS push (phase 3) ----------

function gisLink(wo) {
  return {
    work_order_id: wo.id,
    title: wo.title,
    work_type: wo.work_type,
    priority: wo.priority,
    status: wo.status,
    updated_at: wo.updated_at,
  };
}

/**
 * Push the work order's current state to GIS for every sync row not yet done.
 * Safe to run any number of times: the GIS link is keyed by work order id.
 */
export async function syncPending(db, gis, workOrderId, { now = defaultNow } = {}) {
  const rows = db.prepare("SELECT * FROM gis_sync WHERE work_order_id = ? AND status != 'done' ORDER BY id").all(workOrderId);
  const wo = getWorkOrder(db, workOrderId);
  const failures = [];
  for (const row of rows) {
    try {
      await gis.linkWorkOrder(row.asset_id, gisLink(wo));
      db.prepare("UPDATE gis_sync SET status = 'done', attempts = attempts + 1, last_error = NULL, completed_at = ? WHERE id = ?")
        .run(now(), row.id);
    } catch (err) {
      db.prepare("UPDATE gis_sync SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?")
        .run(String(err.message ?? err), row.id);
      failures.push({ asset_id: row.asset_id, error: String(err.message ?? err) });
    }
  }
  return failures;
}

function queueSync(db, workOrderId, assetIds, at) {
  const insert = db.prepare('INSERT INTO gis_sync (work_order_id, asset_id, requested_at) VALUES (?, ?, ?)');
  for (const assetId of assetIds) insert.run(workOrderId, assetId, at);
}

// ---------- create ----------

async function lookUpAssets(gis, assetIds) {
  if (!assetIds.length) return [];
  if (!gis) throw new ValidationError(['assets were selected but no GIS is connected']);
  const assets = [];
  const missing = [];
  for (const id of assetIds) {
    const asset = await gis.getAsset(id);
    if (asset) assets.push(asset);
    else missing.push(`asset ${id} is not in GIS`);
  }
  if (missing.length) throw new ValidationError(missing);
  return assets;
}

/**
 * Create a work order. A location is required: select at least one GIS asset, or type a
 * freeform location when GIS does not have it (REQ-032). The first asset autofills the
 * address, coordinates and — if left blank — the work type (REQ-023).
 *
 * Throws ValidationError (nothing saved) for missing data or unknown assets, and GisError
 * (nothing saved) if GIS cannot be reached to look the assets up.
 *
 * Idempotent when the caller sends a request_id: the same request sent again (a double-click,
 * a network retry) returns the work order it already made, with duplicate: true, and writes nothing.
 */
export async function createWorkOrder(db, input, { gis = null, now = defaultNow } = {}) {
  const requestId = trimOrNull(input?.request_id);
  const existing = requestId ? findByRequestId(db, requestId) : null;
  if (existing) return { ...getWorkOrderDetail(db, existing.id), gis_failures: [], duplicate: true };

  const assetIds = [...new Set((input?.asset_ids ?? []).map(String))];
  const problems = [];
  if (isBlank(input?.title)) problems.push('title is required');
  if (isBlank(input?.created_by)) problems.push('created_by is required');
  if (!assetIds.length && isBlank(input?.location_text)) problems.push('a location is required: select a GIS asset or enter a location');
  if (!assetIds.length && isBlank(input?.work_type)) problems.push('work_type is required');
  if (problems.length) throw new ValidationError(problems);

  const assets = await lookUpAssets(gis, assetIds);
  const first = assets[0] ?? null;
  const at = now();
  const row = {
    id: randomUUID(),
    title: input.title.trim(),
    description: trimOrNull(input.description),
    work_type: trimOrNull(input.work_type) ?? first.asset_type,
    priority: trimOrNull(input.priority) ?? 'normal',
    status: 'open',
    location_text: trimOrNull(input.location_text),
    address: first?.address ?? null,
    latitude: first?.location?.lat ?? null,
    longitude: first?.location?.lng ?? null,
    created_by: input.created_by.trim(),
    created_at: at,
    updated_at: at,
    completed_at: null,
    completion_note: null,
    request_id: requestId,
  };

  const saved = inTransaction(db, () => {
    // Re-check inside the transaction: two identical requests may have raced past the first check.
    const raced = requestId ? findByRequestId(db, requestId) : null;
    if (raced) return raced;
    db.prepare(`
      INSERT INTO work_orders (id, title, description, work_type, priority, status, location_text, address,
                               latitude, longitude, created_by, created_at, updated_at, completed_at,
                               completion_note, request_id)
      VALUES (:id, :title, :description, :work_type, :priority, :status, :location_text, :address,
              :latitude, :longitude, :created_by, :created_at, :updated_at, :completed_at,
              :completion_note, :request_id)
    `).run(row);
    const insertAsset = db.prepare(`
      INSERT INTO work_order_assets (work_order_id, asset_id, asset_type, asset_name, attributes_json)
      VALUES (?, ?, ?, ?, ?)`);
    for (const a of assets) insertAsset.run(row.id, a.id, a.asset_type ?? null, a.name ?? null, JSON.stringify(a.attributes ?? null));
    queueSync(db, row.id, assets.map((a) => a.id), at);
    writeAudit(db, {
      entityType: 'work_order', entityId: row.id, action: 'create', actor: row.created_by,
      after: { ...row, asset_ids: assets.map((a) => a.id) }, at,
    });
    return null;
  });
  if (saved) return { ...getWorkOrderDetail(db, saved.id), gis_failures: [], duplicate: true };

  const gisFailures = assets.length ? await syncPending(db, gis, row.id, { now }) : [];
  return { ...getWorkOrderDetail(db, row.id), gis_failures: gisFailures, duplicate: false };
}

function findByRequestId(db, requestId) {
  return db.prepare('SELECT * FROM work_orders WHERE request_id = ?').get(requestId) ?? null;
}

// ---------- update ----------

// Fields a user may change with an update. Status changes (e.g. completion) get their own action.
const UPDATABLE = ['title', 'description', 'work_type', 'priority', 'location_text'];
const REQUIRED_ON_UPDATE = new Set(['title', 'work_type']);

function cleanChanges(changes) {
  const problems = [];
  const clean = {};
  for (const [field, value] of Object.entries(changes ?? {})) {
    if (!UPDATABLE.includes(field)) {
      problems.push(`${field} cannot be changed by an update`);
      continue;
    }
    if (REQUIRED_ON_UPDATE.has(field) && isBlank(value)) {
      problems.push(`${field} is required`);
      continue;
    }
    clean[field] = typeof value === 'string' ? trimOrNull(value) : value;
  }
  if (problems.length) throw new ValidationError(problems);
  return clean;
}

/**
 * Change fields on an existing work order, record an 'update' audit entry with the before and
 * after values, and push the change to every linked GIS asset. The change and its audit entry
 * are saved together or not at all — if the audit entry cannot be written, the change is rolled back.
 *
 * `audit` is only replaceable so tests can prove that rollback.
 */
export async function updateWorkOrder(db, id, changes, { actor, gis = null, now = defaultNow, audit = writeAudit } = {}) {
  if (isBlank(actor)) throw new ValidationError(['actor is required']);
  const clean = cleanChanges(changes);

  const result = inTransaction(db, () => {
    const before = getWorkOrder(db, id);
    if (!before) throw new NotFoundError(id);
    if (before.status === 'completed') throw new ConflictError('A completed work order cannot be changed.');

    const changed = Object.keys(clean).filter((f) => clean[f] !== before[f]);
    if (changed.length === 0) return { changed: false }; // nothing changed: nothing to save, audit or sync

    const at = now();
    if (!clean.location_text && changed.includes('location_text') && getAssets(db, id).length === 0) {
      throw new ValidationError(['a location is required: select a GIS asset or enter a location']);
    }
    const sets = changed.map((f) => `${f} = :${f}`).join(', ');
    db.prepare(`UPDATE work_orders SET ${sets}, updated_at = :updated_at WHERE id = :id`)
      .run({ ...Object.fromEntries(changed.map((f) => [f, clean[f]])), updated_at: at, id });

    const after = getWorkOrder(db, id);
    queueSync(db, id, getAssets(db, id).map((a) => a.asset_id), at);
    audit(db, { entityType: 'work_order', entityId: id, action: 'update', actor: actor.trim(), before, after, at });
    return { changed: true };
  });

  const linked = getAssets(db, id).length > 0;
  const gisFailures = result.changed && linked && gis ? await syncPending(db, gis, id, { now }) : [];
  return { ...getWorkOrderDetail(db, id), gis_failures: gisFailures };
}

// ---------- complete ----------

/**
 * Complete a work order (REQ-051). A completion note is required, so a work order is never
 * closed without saying what was done. Audited and pushed to GIS like any other change.
 * Completing an already-completed work order is refused (ConflictError) rather than repeated.
 */
export async function completeWorkOrder(db, id, { note, actor, gis = null, now = defaultNow } = {}) {
  const problems = [];
  if (isBlank(actor)) problems.push('actor is required');
  if (isBlank(note)) problems.push('a completion note is required');
  if (problems.length) throw new ValidationError(problems);

  inTransaction(db, () => {
    const before = getWorkOrder(db, id);
    if (!before) throw new NotFoundError(id);
    if (before.status === 'completed') throw new ConflictError('This work order is already completed.');

    const at = now();
    db.prepare(`UPDATE work_orders SET status = 'completed', completed_at = ?, completion_note = ?, updated_at = ? WHERE id = ?`)
      .run(at, note.trim(), at, id);
    const after = getWorkOrder(db, id);
    queueSync(db, id, getAssets(db, id).map((a) => a.asset_id), at);
    writeAudit(db, { entityType: 'work_order', entityId: id, action: 'complete', actor: actor.trim(), before, after, at });
  });

  const linked = getAssets(db, id).length > 0;
  const gisFailures = linked && gis ? await syncPending(db, gis, id, { now }) : [];
  return { ...getWorkOrderDetail(db, id), gis_failures: gisFailures };
}
