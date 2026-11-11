// What the staff console shows (STORY-014). Read-only: the console changes data only through the
// existing work order API, so this file never writes anything except, via the caller, the audit entry
// for the read itself.

import { ValidationError, NotFoundError, getWorkOrder, getAssets } from './workOrders.js';
import { workflowPosition } from './workflows.js';
import { hasPermission } from './access.js';

const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const FILTERS = ['status', 'assignee', 'limit', 'cursor'];

const nameOf = (db, userId) => (userId ? db.prepare('SELECT id, display_name, email FROM users WHERE id = ?').get(userId) ?? null : null);

/** Where the work is, in words: address, then the freeform location, then coordinates. */
function whereIs(row) {
  if (row.address) return row.address;
  if (row.location_text) return row.location_text;
  if (row.latitude !== null && row.longitude !== null) return `${row.latitude.toFixed(5)}, ${row.longitude.toFixed(5)}`;
  return null;
}

// Newest first. The cursor is the (created_at, id) of the last row shown, so pages never skip or repeat.
const encodeCursor = (createdAt, id) => Buffer.from(JSON.stringify([createdAt, id])).toString('base64url');
function decodeCursor(cursor) {
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (typeof createdAt === 'string' && typeof id === 'string') return { createdAt, id };
  } catch { /* reported below */ }
  return null;
}

/**
 * One page of the work order list: each row with its status, assignee and location.
 * Filters: status (open | completed), assignee (a user id, or "unassigned"). No work orders is an
 * empty page, not an error.
 */
export function listConsoleWorkOrders(db, params = {}) {
  const problems = Object.keys(params).filter((k) => !FILTERS.includes(k)).map((k) => `${k} is not a filter; use ${FILTERS.join(', ')}`);
  if (params.status !== undefined && !['open', 'completed'].includes(params.status)) problems.push('status must be open or completed');
  const limit = params.limit === undefined ? PAGE_SIZE : Number(params.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) problems.push(`limit must be 1 to ${MAX_PAGE_SIZE}`);
  const after = params.cursor ? decodeCursor(params.cursor) : null;
  if (params.cursor && !after) problems.push('cursor is not valid; use next_cursor from the previous page');
  if (problems.length) throw new ValidationError(problems);

  const where = [];
  const args = [];
  if (params.status) { where.push('status = ?'); args.push(params.status); }
  if (params.assignee === 'unassigned') where.push('assigned_to IS NULL');
  else if (params.assignee) { where.push('assigned_to = ?'); args.push(params.assignee); }
  const total = db.prepare(`SELECT COUNT(*) AS n FROM work_orders ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`).get(...args).n;
  if (after) { where.push('(created_at < ? OR (created_at = ? AND id < ?))'); args.push(after.createdAt, after.createdAt, after.id); }

  const rows = db.prepare(`SELECT * FROM work_orders ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                           ORDER BY created_at DESC, id DESC LIMIT ?`).all(...args, limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    total,
    items: page.map((row) => {
      const assignee = nameOf(db, row.assigned_to);
      return {
        id: row.id, title: row.title, work_type: row.work_type, priority: row.priority, status: row.status,
        step: workflowPosition(db, row).current_step_name,
        assignee: assignee ? { id: assignee.id, name: assignee.display_name } : null,
        location: whereIs(row), created_at: row.created_at, updated_at: row.updated_at, version: row.version,
      };
    }),
    next_cursor: rows.length > limit ? encodeCursor(last.created_at, last.id) : null,
  };
}

/** One history line in words, from an audit entry. */
function describe(db, entry) {
  const before = entry.before_json ? JSON.parse(entry.before_json) : null;
  const after = entry.after_json ? JSON.parse(entry.after_json) : null;
  switch (entry.action) {
    case 'create': return 'Created';
    case 'update': {
      const changed = ['title', 'description', 'work_type', 'priority', 'location_text'].filter((f) => before?.[f] !== after?.[f]);
      return changed.length ? `Changed ${changed.map((f) => `${f.replace('_', ' ')}: ${before[f] ?? '—'} → ${after[f] ?? '—'}`).join('; ')}` : 'Updated';
    }
    case 'transition': return `Moved from "${before?.step_name ?? before?.current_step}" to "${after?.step_name ?? after?.current_step}"`;
    case 'assign': {
      const who = (id) => (id ? nameOf(db, id)?.display_name ?? id : 'Unassigned');
      return `Assigned: ${who(before?.assigned_to)} → ${who(after?.assigned_to)}`;
    }
    case 'complete': return `Completed: ${after?.completion_note ?? ''}`.trim();
    case 'gis_update': return 'Location details updated from GIS';
    case 'publish': return after?.is_public ? 'Published on the public site' : 'Removed from the public site';
    default: return entry.action.replace(/_/g, ' ');
  }
}

/** A work order's full detail from the database: the record, its assignee, workflow step and full history. */
export function consoleWorkOrderDetail(db, id) {
  const row = getWorkOrder(db, String(id ?? ''));
  if (!row) throw new NotFoundError(id);
  const assignee = nameOf(db, row.assigned_to);
  const history = db.prepare("SELECT * FROM audit_entries WHERE entity_type = 'work_order' AND entity_id = ? ORDER BY id").all(row.id)
    .map((e) => ({ at: e.occurred_at, action: e.action, by: e.actor, by_user_id: e.actor_user_id, what: describe(db, e) }));
  return {
    item: {
      id: row.id, title: row.title, description: row.description, work_type: row.work_type, priority: row.priority, status: row.status,
      location: { text: row.location_text, address: row.address, latitude: row.latitude, longitude: row.longitude },
      assignee: assignee ? { id: assignee.id, name: assignee.display_name, email: assignee.email } : null,
      workflow: workflowPosition(db, row),
      created_by: row.created_by, created_at: row.created_at, updated_at: row.updated_at, completed_at: row.completed_at,
      completion_note: row.completion_note, version: row.version,
    },
    history,
    saved_assets: getAssets(db, row.id).map((a) => ({ id: a.asset_id, asset_type: a.asset_type, name: a.asset_name, attributes: a.attributes })),
  };
}

/**
 * The live GIS record for each asset, with the saved copy as the fallback. GIS is asked through its
 * client, which has its own timeout and capped retries; if it cannot answer, the saved copy is shown
 * with gis_status "unavailable" and the rest of the screen still works.
 */
export async function withLiveGis(detail, gis) {
  if (!detail.saved_assets.length) return { ...detail, gis_status: 'no_assets', gis_records: [] };
  if (!gis) return { ...detail, gis_status: 'not_connected', gis_records: detail.saved_assets.map((a) => ({ ...a, source: 'saved copy' })) };
  try {
    const live = await Promise.all(detail.saved_assets.map((a) => gis.getAsset(a.id)));
    return { ...detail, gis_status: 'live', gis_records: live.map((rec, i) => (rec ? { ...rec, source: 'live GIS' } : { ...detail.saved_assets[i], source: 'saved copy (no longer in GIS)' })) };
  } catch (err) {
    return {
      ...detail, gis_status: 'unavailable', gis_error: String(err.message ?? err).slice(0, 200),
      gis_records: detail.saved_assets.map((a) => ({ ...a, source: 'saved copy' })),
    };
  }
}

/** People work can be assigned to: active, and allowed to change work orders. */
export function assignableUsers(db) {
  return db.prepare('SELECT id, display_name, email FROM users WHERE is_active = 1 ORDER BY display_name').all()
    .filter((u) => hasPermission(db, u.id, 'work_orders:write'))
    .map((u) => ({ id: u.id, name: u.display_name, email: u.email }));
}
