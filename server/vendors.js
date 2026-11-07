// Vendor data contracts (STORY-009, REQ-054, REQ-055).
//
// The RFP says Lama, SpryPoint and Madison AI "have no current interface but should be API" (REQ-055)
// and that these integrations are one-way (REQ-042). So the work order system publishes a feed and
// each vendor reads from it; nothing a vendor sends changes our data.
//
// Each vendor has its own versioned contract: exactly which fields it receives. A record is shaped
// for one vendor and one contract version, then checked against that contract before it is sent —
// a record that does not match is never sent ("data mismatch").
//
//   Madison AI  the full read format already published for indexing (STORY-011). Agreed by the RFP's
//               own wording (REQ-040: index, crawl and search internal work order data).
//   Lama,       PLACEHOLDER minimal contracts, proposed until each vendor confirms what it needs:
//   SpryPoint   identifiers, type, status, where and when — no free text and no names, because free
//               text written by staff or citizens can contain personal details.
//
// SCADA is named in REQ-042 but not in REQ-055; it is an open question, not built.

import { ValidationError, NotFoundError } from './workOrders.js';
import { toPublic, validateWorkOrder, WORK_ORDER_FIELDS } from './api/workOrderFeed.js';

/** Fields that can carry personal details; only Madison AI's agreed full format includes them. */
export const PERSONAL_FIELDS = ['title', 'description', 'completion_note', 'created_by', 'location.text', 'assets'];

// The minimal shape proposed for Lama and SpryPoint. type: string | number | array, '?' = may be null.
const MINIMAL_FIELDS = {
  id: 'string',
  work_type: 'string',
  priority: 'string',
  status: 'string',
  address: 'string?',
  latitude: 'number?',
  longitude: 'number?',
  asset_ids: 'array',
  created_at: 'string',
  updated_at: 'string',
  completed_at: 'string?',
};

function minimalRecord(item) {
  return {
    id: item.id,
    work_type: item.work_type,
    priority: item.priority,
    status: item.status,
    address: item.location.address,
    latitude: item.location.latitude,
    longitude: item.location.longitude,
    asset_ids: item.assets.map((a) => a.asset_id),
    created_at: item.created_at,
    updated_at: item.updated_at,
    completed_at: item.completed_at,
  };
}

function checkMinimal(record, path = 'item') {
  const problems = [];
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return [`${path} must be an object`];
  for (const [field, spec] of Object.entries(MINIMAL_FIELDS)) {
    const optional = spec.endsWith('?');
    const type = optional ? spec.slice(0, -1) : spec;
    const v = record[field];
    if (!(field in record)) problems.push(`${path}.${field} is missing`);
    else if (v === null) { if (!optional) problems.push(`${path}.${field} must not be null`); }
    else if (type === 'array' ? !(Array.isArray(v) && v.every((x) => typeof x === 'string')) : typeof v !== type) problems.push(`${path}.${field} must be ${type}`);
  }
  for (const field of Object.keys(record)) if (!(field in MINIMAL_FIELDS)) problems.push(`${path}.${field} is not part of this vendor's contract`);
  for (const f of ['created_at', 'updated_at', 'completed_at']) {
    if (typeof record[f] === 'string' && Number.isNaN(Date.parse(record[f]))) problems.push(`${path}.${f} must be an ISO date-time`);
  }
  return problems;
}

/**
 * Every vendor and its contracts. `status` says whether the contract is agreed or only proposed;
 * `scope` is the API permission a vendor's key needs for its own feed (used from Step 2).
 */
export const VENDORS = {
  madison_ai: {
    name: 'Madison AI',
    purpose: 'Indexes, crawls and searches work order data (REQ-040, REQ-055).',
    scope: 'vendor_feed:madison_ai',
    contracts: {
      1: { status: 'agreed', fields: Object.keys(WORK_ORDER_FIELDS), shape: (db, row) => toPublic(db, row), check: validateWorkOrder },
    },
  },
  lama: {
    name: 'Lama',
    purpose: 'PLACEHOLDER: receives work order status and location; what Lama needs is to be confirmed with the vendor (REQ-054).',
    scope: 'vendor_feed:lama',
    contracts: {
      1: { status: 'proposed', fields: Object.keys(MINIMAL_FIELDS), shape: (db, row) => minimalRecord(toPublic(db, row)), check: checkMinimal },
    },
  },
  sprypoint: {
    name: 'SpryPoint',
    purpose: 'PLACEHOLDER: receives work order status and location; what SpryPoint needs is to be confirmed with the vendor (REQ-054).',
    scope: 'vendor_feed:sprypoint',
    contracts: {
      1: { status: 'proposed', fields: Object.keys(MINIMAL_FIELDS), shape: (db, row) => minimalRecord(toPublic(db, row)), check: checkMinimal },
    },
  },
};

/** The vendor, by key. Unknown vendor → NotFoundError. */
export function getVendor(vendorKey) {
  const vendor = Object.hasOwn(VENDORS, vendorKey) ? VENDORS[vendorKey] : null;
  if (!vendor) {
    const err = new NotFoundError(vendorKey);
    err.message = `No vendor ${vendorKey}. Vendors: ${Object.keys(VENDORS).join(', ')}`;
    throw err;
  }
  return vendor;
}

/** One contract version; the newest when version is omitted. An unknown version lists the ones that exist. */
export function getContract(vendorKey, version) {
  const vendor = getVendor(vendorKey);
  const versions = Object.keys(vendor.contracts).map(Number);
  const v = version === undefined ? Math.max(...versions) : Number(version);
  if (!Number.isInteger(v) || !versions.includes(v)) {
    throw new ValidationError([`${vendor.name} has no contract version ${version}; available: ${versions.join(', ')}`]);
  }
  return { vendor: vendorKey, name: vendor.name, version: v, ...vendor.contracts[v] };
}

/** Problems with a record against a vendor's contract; an empty list means it may be sent. */
export function validateForVendor(vendorKey, version, record, path = 'item') {
  return getContract(vendorKey, version).check(record, path);
}

/**
 * A work order shaped for one vendor and contract version, checked before it is returned.
 * Throws ContractMismatchError rather than ever returning data that breaks the contract.
 */
export function toVendorRecord(db, vendorKey, version, row) {
  const contract = getContract(vendorKey, version);
  const record = contract.shape(db, row);
  const problems = contract.check(record);
  if (problems.length) throw new ContractMismatchError(vendorKey, contract.version, problems);
  return record;
}

/** Our data did not fit the vendor's contract. Nothing was sent. */
export class ContractMismatchError extends Error {
  constructor(vendorKey, version, problems) {
    super(`Data for ${vendorKey} did not match contract version ${version}, so it was not sent: ${problems.join('; ')}`);
    this.name = 'ContractMismatchError';
    this.problems = problems;
  }
}

/** Vendors and their contracts as published (no functions), for the API and documentation. */
export function describeVendors() {
  return Object.entries(VENDORS).map(([key, v]) => ({
    key, name: v.name, purpose: v.purpose, direction: 'one-way: the vendor reads from us (REQ-042)',
    contracts: Object.entries(v.contracts).map(([version, c]) => ({ version: Number(version), status: c.status, fields: c.fields })),
  }));
}

// ---------- the feed each vendor reads ----------
//
// Work orders created or changed, oldest change first, a page at a time, shaped for one vendor and
// contract version. The cursor is the (updated_at, id) of the last record returned, so pages never skip
// or repeat. next_cursor is ALWAYS given — on the last page too — so a vendor that saves it and comes
// back later receives only what changed since. has_more says whether to fetch the next page now.

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const FEED_PARAMS = ['contract', 'since', 'limit', 'cursor'];

const encodeCursor = (time, id) => Buffer.from(JSON.stringify([time, id])).toString('base64url');
function decodeCursor(cursor) {
  try {
    const [time, id] = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (typeof time === 'string' && typeof id === 'string') return { time, id };
  } catch { /* reported below */ }
  return null;
}

/** Check the feed parameters; every problem is listed at once. */
export function parseFeedParams(params = {}) {
  const problems = Object.keys(params).filter((k) => !FEED_PARAMS.includes(k)).map((k) => `${k} is not a feed parameter; use ${FEED_PARAMS.join(', ')}`);
  let since = null;
  if (params.since !== undefined && params.since !== '') {
    if (Number.isNaN(Date.parse(params.since))) problems.push('since must be an ISO date-time, e.g. 2026-11-01T00:00:00Z');
    else since = new Date(params.since).toISOString();
  }
  const limit = params.limit === undefined || params.limit === '' ? DEFAULT_LIMIT : Number(params.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) problems.push(`limit must be a whole number from 1 to ${MAX_LIMIT}`);
  const after = params.cursor === undefined || params.cursor === '' ? null : decodeCursor(params.cursor);
  if (params.cursor && !after) problems.push('cursor is not valid; use next_cursor from the previous page');
  if (problems.length) throw new ValidationError(problems);
  return { since, limit, after, contract: params.contract === undefined || params.contract === '' ? undefined : params.contract };
}

/** One page of a vendor's feed. Every record is checked against the contract; one bad record stops the whole page. */
export function vendorFeed(db, vendorKey, params = {}) {
  const { since, limit, after, contract: requested } = parseFeedParams(params);
  const contract = getContract(vendorKey, requested);
  const where = [];
  const args = [];
  if (since) { where.push('updated_at > ?'); args.push(since); }
  if (after) { where.push('(updated_at > ? OR (updated_at = ? AND id > ?))'); args.push(after.time, after.time, after.id); }
  const rows = db.prepare(`SELECT * FROM work_orders ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at, id LIMIT ?`)
    .all(...args, limit + 1);
  const more = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const items = pageRows.map((row) => toVendorRecord(db, vendorKey, contract.version, row));
  const last = pageRows[pageRows.length - 1];
  return {
    vendor: vendorKey, contract_version: contract.version, contract_status: contract.status, items,
    // Nothing new: hand back the vendor's own position, so it can keep polling from the same place.
    next_cursor: last ? encodeCursor(last.updated_at, last.id) : (params.cursor || null),
    has_more: more,
  };
}

/** Record one vendor request in vendor_exchange_log. Throws if it cannot be written. */
export function logExchange(db, entry) {
  db.prepare(`INSERT INTO vendor_exchange_log (request_id, vendor, client_name, contract_version, params_json, records_returned,
              outcome, error, started_at, finished_at, duration_ms)
              VALUES (:request_id, :vendor, :client_name, :contract_version, :params_json, :records_returned,
              :outcome, :error, :started_at, :finished_at, :duration_ms)`).run({
    request_id: entry.requestId ?? null,
    vendor: String(entry.vendor).slice(0, 60),
    client_name: entry.clientName,
    contract_version: entry.contractVersion ?? null,
    params_json: entry.params && Object.keys(entry.params).length ? JSON.stringify(entry.params) : null,
    records_returned: entry.recordsReturned ?? 0,
    outcome: entry.outcome,
    error: entry.error ? String(entry.error).slice(0, 1000) : null,
    started_at: entry.startedAt,
    finished_at: entry.finishedAt,
    duration_ms: Math.max(0, Date.parse(entry.finishedAt) - Date.parse(entry.startedAt)),
  });
}

