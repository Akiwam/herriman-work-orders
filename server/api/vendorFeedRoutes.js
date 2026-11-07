// Vendor feeds over HTTP (STORY-009, REQ-054, REQ-055). One-way: vendors read, nothing they send changes data.
//
//   GET /api/v1/vendors                    the vendors and their published contracts (no key needed; holds no data)
//   GET /api/v1/vendors/{vendor}/feed      that vendor's feed: ?contract=1&since=…&limit=…&cursor=…
//                                          needs the vendor's own scope, e.g. vendor_feed:lama
//   GET /api/v1/vendors/{vendor}/coordination          the REQ-054 coordination steps   (readiness:review)
//   PUT /api/v1/vendors/{vendor}/coordination/{step}   record a step: { done, note }     (readiness:review, personal key)
//
// Every feed request is written to vendor_exchange_log whatever happens — ok, denied, invalid,
// mismatch or error — with times and request details. Data is only sent once its log row and audit
// entry are saved in the same transaction; if they cannot be, nothing is sent.

import { send, readJsonBody } from './http.js';
import {
  requireAccess, requirePerson, auditedRead, authenticate, AuditUnavailableError, UnauthorizedError, ForbiddenError,
} from './clients.js';
import { getCoordination, recordStep } from '../vendorCoordination.js';
import { inTransaction } from '../db.js';
import { writeAudit, ValidationError, NotFoundError } from '../workOrders.js';
import { getVendor, vendorFeed, logExchange, describeVendors, ContractMismatchError } from '../vendors.js';

export const VENDORS_BASE = '/api/v1/vendors';
const FEED = new RegExp(`^${VENDORS_BASE}/([^/]+)/feed$`);
const COORDINATION = new RegExp(`^${VENDORS_BASE}/([^/]+)/coordination(?:/([^/]+))?$`);
const defaultNow = () => new Date().toISOString();

export const isVendorFeedPath = (pathname) => pathname === VENDORS_BASE || FEED.test(pathname) || COORDINATION.test(pathname);

/** The coordination tracker: read it, or record one step. */
async function handleCoordination(req, res, db, match, { key, now }) {
  const vendorKey = decodeURIComponent(match[1]);
  const step = match[2] ? decodeURIComponent(match[2]) : null;
  const opts = { now };
  if (!step) {
    if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed', message: 'Use GET here' }, { Allow: 'GET' });
    send(res, 200, auditedRead(db, { key, operation: 'vendorCoordination', params: { vendor: vendorKey }, scope: 'readiness:review' },
      () => ({ item: getCoordination(db, vendorKey) }), opts));
    return;
  }
  if (req.method !== 'PUT') return send(res, 405, { error: 'method_not_allowed', message: 'Use PUT here' }, { Allow: 'PUT' });
  const reviewer = requirePerson(db, { key, operation: 'recordVendorCoordination', params: { vendor: vendorKey, step }, scope: 'readiness:review' });
  const body = await readJsonBody(req);
  const { coordination, changed } = recordStep(db, vendorKey, step, body, { actorUserId: reviewer.user_id, ...opts });
  send(res, 200, { item: coordination, changed });
}

function outcomeOf(err) {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) return 'denied';
  if (err instanceof ValidationError || err instanceof NotFoundError) return 'invalid';
  if (err instanceof ContractMismatchError) return 'mismatch';
  return 'error';
}

export async function handleVendorFeed(req, res, db, url, { key, now = defaultNow } = {}) {
  const coordination = COORDINATION.exec(url.pathname);
  if (coordination) {
    await handleCoordination(req, res, db, coordination, { key, now });
    return;
  }
  if (req.method !== 'GET') {
    send(res, 405, { error: 'method_not_allowed', message: 'Vendor feeds are read-only (one-way). Use GET.' }, { Allow: 'GET' });
    return;
  }
  if (url.pathname === VENDORS_BASE) {
    send(res, 200, { items: describeVendors() });
    return;
  }

  const vendorKey = decodeURIComponent(FEED.exec(url.pathname)[1]);
  const params = Object.fromEntries(url.searchParams);
  const startedAt = now();
  const requestId = res.getHeader('X-Request-Id') ?? null;
  const caller = () => authenticate(db, key)?.name ?? (key ? 'invalid key' : 'anonymous');

  try {
    const vendor = getVendor(vendorKey);
    const client = requireAccess(db, { key, operation: 'vendorFeed', params: { vendor: vendorKey, ...params }, scope: vendor.scope }, { at: startedAt });
    const body = inTransaction(db, () => {
      const page = vendorFeed(db, vendorKey, params);
      const finishedAt = now();
      writeAudit(db, {
        entityType: 'api_access', entityId: client.id, action: 'read', actor: client.name,
        after: { operation: 'vendorFeed', params: { vendor: vendorKey, ...params }, records_returned: page.items.length }, at: finishedAt,
      });
      logExchange(db, {
        requestId, vendor: vendorKey, clientName: client.name, contractVersion: page.contract_version, params,
        recordsReturned: page.items.length, outcome: 'ok', startedAt, finishedAt,
      });
      return page;
    });
    send(res, 200, body);
  } catch (err) {
    // The failure is logged too. If even that cannot be written, say so rather than hide it.
    try {
      logExchange(db, {
        requestId, vendor: vendorKey, clientName: caller(), params, outcome: outcomeOf(err),
        error: err.message, startedAt, finishedAt: now(),
      });
    } catch (logErr) {
      throw new AuditUnavailableError(logErr);
    }
    throw err;
  }
}
