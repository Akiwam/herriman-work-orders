// Reading the audit trail (STORY-007, REQ-047).
//
// The audit trail is append-only: nothing in the system updates or deletes audit_entries. This is
// how auditors read it — filtered by who acted, on what, which action and when, a page at a time,
// oldest first. Over the API it is wrapped in auditedRead, so reading the audit trail is itself audited.

import { ValidationError } from './workOrders.js';

const FILTERS = ['user_id', 'entity_type', 'entity_id', 'action', 'from', 'to', 'limit', 'cursor'];
export const AUDIT_FILTERS = FILTERS;
const MAX_LIMIT = 200;

const isTime = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

function parseFilters(params) {
  const problems = [];
  for (const k of Object.keys(params)) if (!FILTERS.includes(k)) problems.push(`${k} is not a filter; use ${FILTERS.join(', ')}`);
  for (const k of ['from', 'to']) if (params[k] !== undefined && !isTime(params[k])) problems.push(`${k} must be a date and time, e.g. 2026-11-01T00:00:00Z`);
  const limit = params.limit === undefined ? 50 : Number(params.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) problems.push(`limit must be 1 to ${MAX_LIMIT}`);
  const cursor = params.cursor === undefined ? 0 : Number(params.cursor);
  if (!Number.isInteger(cursor) || cursor < 0) problems.push('cursor must be the next_cursor from the previous page');
  if (problems.length) throw new ValidationError(problems);
  return { limit, cursor };
}

/** One page of audit entries matching the filters, oldest first, with next_cursor for the next page. */
export function listAuditEntries(db, params = {}) {
  const { limit, cursor } = parseFilters(params);
  const where = ['id > :cursor'];
  const args = { cursor, limit: limit + 1 };
  if (params.user_id) { where.push('actor_user_id = :user_id'); args.user_id = params.user_id; }
  if (params.entity_type) { where.push('entity_type = :entity_type'); args.entity_type = params.entity_type; }
  if (params.entity_id) { where.push('entity_id = :entity_id'); args.entity_id = params.entity_id; }
  if (params.action) { where.push('action = :action'); args.action = params.action; }
  if (params.from) { where.push('occurred_at >= :from'); args.from = new Date(params.from).toISOString(); }
  if (params.to) { where.push('occurred_at < :to'); args.to = new Date(params.to).toISOString(); }

  const rows = db.prepare(`SELECT * FROM audit_entries WHERE ${where.join(' AND ')} ORDER BY id LIMIT :limit`).all(args);
  const page = rows.slice(0, limit);
  return {
    items: page.map((r) => ({
      id: r.id, occurred_at: r.occurred_at, entity_type: r.entity_type, entity_id: r.entity_id, action: r.action,
      actor: r.actor, actor_user_id: r.actor_user_id,
      before: r.before_json === null ? null : JSON.parse(r.before_json),
      after: r.after_json === null ? null : JSON.parse(r.after_json),
    })),
    next_cursor: rows.length > limit ? String(page.at(-1).id) : null,
  };
}
