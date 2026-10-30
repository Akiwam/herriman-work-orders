// The read-only work order feed for indexing and search engines such as Madison AI (STORY-011).
//
// Every response has one fixed, versioned shape (WORK_ORDER_FIELDS below). Only these fields leave
// the system: internal columns such as request_id, the gis_sync queue and the audit trail never do.
// Call these through auditedRead() so every access is authenticated and audited.

import { ValidationError, NotFoundError, getAssets } from '../workOrders.js';

export const SCHEMA_VERSION = 1;
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/** The published shape of one work order. type: string | number | null-able variants, object, array. */
export const WORK_ORDER_FIELDS = {
  id: 'string',
  title: 'string',
  description: 'string?',
  work_type: 'string',
  priority: 'string',
  status: 'string',
  location: 'object',
  assets: 'array',
  created_by: 'string',
  created_at: 'string',
  updated_at: 'string',
  completed_at: 'string?',
  completion_note: 'string?',
};
const LOCATION_FIELDS = { text: 'string?', address: 'string?', latitude: 'number?', longitude: 'number?' };
const ASSET_FIELDS = { asset_id: 'string', asset_type: 'string?', name: 'string?', attributes: 'object?' };

function checkFields(value, fields, path, problems) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    problems.push(`${path} must be an object`);
    return;
  }
  for (const [field, spec] of Object.entries(fields)) {
    const optional = spec.endsWith('?');
    const type = optional ? spec.slice(0, -1) : spec;
    const v = value[field];
    if (!(field in value)) problems.push(`${path}.${field} is missing`);
    else if (v === null) { if (!optional) problems.push(`${path}.${field} must not be null`); }
    else if (type === 'array' ? !Array.isArray(v) : (type === 'object' ? (typeof v !== 'object' || Array.isArray(v)) : typeof v !== type)) {
      problems.push(`${path}.${field} must be ${type}`);
    }
  }
  for (const field of Object.keys(value)) {
    if (!(field in fields)) problems.push(`${path}.${field} is not part of the published format`);
  }
}

/** Problems with one work order against the published format; an empty list means it is correct. */
export function validateWorkOrder(item, path = 'item') {
  const problems = [];
  checkFields(item, WORK_ORDER_FIELDS, path, problems);
  if (item && typeof item === 'object') {
    if (item.location && typeof item.location === 'object') checkFields(item.location, LOCATION_FIELDS, `${path}.location`, problems);
    if (Array.isArray(item.assets)) item.assets.forEach((a, i) => checkFields(a, ASSET_FIELDS, `${path}.assets[${i}]`, problems));
    for (const f of ['created_at', 'updated_at', 'completed_at']) {
      if (typeof item[f] === 'string' && Number.isNaN(Date.parse(item[f]))) problems.push(`${path}.${f} must be an ISO date-time`);
    }
  }
  return problems;
}

/** Problems with a whole response (list, changes, search or single). */
export function validateResponse(response) {
  const problems = [];
  if (response?.schema_version !== SCHEMA_VERSION) problems.push(`schema_version must be ${SCHEMA_VERSION}`);
  if ('item' in (response ?? {})) problems.push(...validateWorkOrder(response.item));
  else if (Array.isArray(response?.items)) response.items.forEach((it, i) => problems.push(...validateWorkOrder(it, `items[${i}]`)));
  else problems.push('response must have item or items');
  if ('next_cursor' in (response ?? {}) && response.next_cursor !== null && typeof response.next_cursor !== 'string') {
    problems.push('next_cursor must be a string or null');
  }
  return problems;
}

/** Turn a database row into the published shape. The only way work order data leaves the system. */
export function toPublic(db, row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    work_type: row.work_type,
    priority: row.priority,
    status: row.status,
    location: { text: row.location_text, address: row.address, latitude: row.latitude, longitude: row.longitude },
    assets: getAssets(db, row.id).map((a) => ({
      asset_id: a.asset_id, asset_type: a.asset_type, name: a.asset_name, attributes: a.attributes,
    })),
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
    completion_note: row.completion_note,
  };
}

// ---------- parameters ----------

function parseLimit(limit) {
  if (limit === undefined || limit === null || limit === '') return DEFAULT_LIMIT;
  const n = Number(limit);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw new ValidationError([`limit must be a whole number from 1 to ${MAX_LIMIT}`]);
  return n;
}

// A cursor is the (sort time, id) of the last item on the previous page, so pages never skip or repeat.
const encodeCursor = (time, id) => Buffer.from(JSON.stringify([time, id])).toString('base64url');
function decodeCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  try {
    const [time, id] = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (typeof time === 'string' && typeof id === 'string') return { time, id };
  } catch { /* fall through to the error below */ }
  throw new ValidationError(['cursor is not valid; use next_cursor from the previous page']);
}

function page(db, { sortColumn, where = '', args = [], limit, cursor }) {
  const after = decodeCursor(cursor);
  const conditions = [where, after ? `(${sortColumn} > ? OR (${sortColumn} = ? AND id > ?))` : ''].filter(Boolean);
  const rows = db.prepare(`SELECT * FROM work_orders ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
                           ORDER BY ${sortColumn}, id LIMIT ?`)
    .all(...args, ...(after ? [after.time, after.time, after.id] : []), limit + 1);
  const more = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    schema_version: SCHEMA_VERSION,
    items: items.map((r) => toPublic(db, r)),
    next_cursor: more ? encodeCursor(last[sortColumn], last.id) : null,
  };
}

// ---------- the four reads ----------

/** Every work order, oldest first, a page at a time. Follow next_cursor until it is null. */
export function listWorkOrders(db, { limit, cursor } = {}) {
  return page(db, { sortColumn: 'created_at', limit: parseLimit(limit), cursor });
}

/** Work orders created or changed after `since` (ISO date-time), for incremental re-indexing. */
export function workOrderChanges(db, { since, limit, cursor } = {}) {
  if (typeof since !== 'string' || Number.isNaN(Date.parse(since))) {
    throw new ValidationError(['since must be an ISO date-time, e.g. 2026-10-30T00:00:00Z']);
  }
  const sinceIso = new Date(since).toISOString();
  return page(db, { sortColumn: 'updated_at', where: 'updated_at > ?', args: [sinceIso], limit: parseLimit(limit), cursor });
}

/** Keyword search over title, description, work type, freeform location and address. Newest first. */
export function searchWorkOrders(db, { q, limit } = {}) {
  const query = typeof q === 'string' ? q.trim() : '';
  if (query.length < 2) throw new ValidationError(['q must be at least 2 characters']);
  const like = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const columns = ['title', 'description', 'work_type', 'location_text', 'address'];
  const rows = db.prepare(`SELECT * FROM work_orders WHERE ${columns.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')}
                           ORDER BY updated_at DESC, id LIMIT ?`).all(...columns.map(() => like), parseLimit(limit));
  return { schema_version: SCHEMA_VERSION, query, items: rows.map((r) => toPublic(db, r)) };
}

/** One work order by id. */
export function getPublicWorkOrder(db, { id } = {}) {
  const row = db.prepare('SELECT * FROM work_orders WHERE id = ?').get(String(id ?? ''));
  if (!row) throw new NotFoundError(id);
  return { schema_version: SCHEMA_VERSION, item: toPublic(db, row) };
}
