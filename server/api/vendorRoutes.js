// The vendor submission portal (STORY-012).
//
// Vendors (scope vendor:submit) — see and change only their own:
//   GET  /api/v1/vendor/requirements               the requirements to answer
//   POST /api/v1/vendor/submissions                submit an answer (+ documents) for one requirement
//   GET  /api/v1/vendor/summary                    their status for every requirement
//   GET  /api/v1/vendor/submissions/{id}           one of their submissions
//   GET  /api/v1/vendor/documents/{id}             download one of their documents
// City reviewers (scope vendor:review):
//   GET  /api/v1/vendor/requirements, /submissions/{id}, /documents/{id}   any vendor's
//   GET  /api/v1/vendor/review-queue               everything waiting for review, oldest first
//   POST /api/v1/vendor/submissions/{id}/review    approve or request changes
//
// A vendor asking for another vendor's submission gets the same 404 as for one that does not exist.

import { send, readJsonBody } from './http.js';
import { authenticate, requireAccess, auditedRead, VENDOR_SUBMIT_SCOPE, VENDOR_REVIEW_SCOPE } from './clients.js';
import {
  requirementCatalog, submitCompliance, getSubmission, getDocuments, getDocumentContent, reviewSubmission,
  reviewQueue, vendorComplianceSummary, SubmissionNotFoundError, MAX_DOCUMENTS, MAX_DOCUMENT_BYTES,
} from '../vendorSubmissions.js';
import { ValidationError } from '../workOrders.js';

export const VENDOR_BASE = '/api/v1/vendor';

// Room for MAX_DOCUMENTS files of MAX_DOCUMENT_BYTES each once base64-encoded (×4/3), plus the text.
const SUBMISSION_MAX_BYTES = Math.ceil(MAX_DOCUMENTS * MAX_DOCUMENT_BYTES * (4 / 3)) + 64 * 1024;
// The only body fields each endpoint accepts. Also the source of the OpenAPI request bodies.
export const SUBMISSION_FIELDS = ['requirement_id', 'compliance', 'technical_approach', 'submission_key', 'documents'];
export const REVIEW_FIELDS = ['decision', 'comment'];

const ROUTES = [
  { method: 'GET', pattern: /^\/requirements$/, name: 'requirements' },
  { method: 'POST', pattern: /^\/submissions$/, name: 'submit' },
  { method: 'GET', pattern: /^\/summary$/, name: 'summary' },
  { method: 'GET', pattern: /^\/review-queue$/, name: 'queue' },
  { method: 'GET', pattern: /^\/submissions\/([^/]+)$/, name: 'submission' },
  { method: 'POST', pattern: /^\/submissions\/([^/]+)\/review$/, name: 'review' },
  { method: 'GET', pattern: /^\/documents\/([^/]+)$/, name: 'document' },
];

function onlyFields(body, allowed) {
  const extra = Object.keys(body).filter((f) => !allowed.includes(f));
  if (extra.length) throw new ValidationError(extra.map((f) => `${f} is not a field this endpoint accepts`));
}

/** Who may see one submission: the vendor that sent it, or any reviewer. Everyone else: "not found". */
function canSee(client, isReviewer, row) {
  return Boolean(row) && (isReviewer || row.vendor_id === client.id);
}

/** For endpoints both vendors and reviewers use: check the key with whichever scope it carries. */
function eitherRole(db, key) {
  const pre = authenticate(db, key);
  const scope = pre?.scopes.includes(VENDOR_REVIEW_SCOPE) ? VENDOR_REVIEW_SCOPE : VENDOR_SUBMIT_SCOPE;
  return { scope, isReviewer: scope === VENDOR_REVIEW_SCOPE };
}

function submissionView(db, row) {
  const { submission_key: _k, ...rest } = row;
  return { ...rest, documents: getDocuments(db, row.id) };
}

export async function handleVendor(req, res, db, url, { key, now } = {}) {
  const path = url.pathname.slice(VENDOR_BASE.length);
  const matches = ROUTES.filter((r) => r.pattern.test(path));
  if (!matches.length) {
    send(res, 404, { error: 'not_found', message: `No vendor endpoint at ${url.pathname}` });
    return;
  }
  const route = matches.find((r) => r.method === req.method);
  if (!route) {
    const allow = [...new Set(matches.map((r) => r.method))].join(', ');
    send(res, 405, { error: 'method_not_allowed', message: `Use ${allow} here` }, { Allow: allow });
    return;
  }
  const param = decodeURIComponent(route.pattern.exec(path)[1] ?? '');
  const opts = now ? { now } : {};

  switch (route.name) {
    case 'requirements': {
      const { scope } = eitherRole(db, key);
      const body = auditedRead(db, { key, operation: 'listRequirements', scope }, () => ({ items: requirementCatalog() }), opts);
      send(res, 200, body);
      return;
    }
    case 'submit': {
      const vendor = requireAccess(db, { key, operation: 'submitCompliance', scope: VENDOR_SUBMIT_SCOPE });
      const body = await readJsonBody(req, { maxBytes: SUBMISSION_MAX_BYTES });
      onlyFields(body, SUBMISSION_FIELDS);
      const r = submitCompliance(db, vendor, {
        requirementId: body.requirement_id, compliance: body.compliance, technicalApproach: body.technical_approach,
        submissionKey: body.submission_key, documents: body.documents,
      }, opts);
      send(res, r.duplicate ? 200 : 201, { item: r });
      return;
    }
    case 'summary': {
      const body = auditedRead(db, { key, operation: 'vendorSummary', scope: VENDOR_SUBMIT_SCOPE },
        () => vendorComplianceSummary(db, authenticate(db, key).id), opts);
      send(res, 200, body);
      return;
    }
    case 'queue': {
      const body = auditedRead(db, { key, operation: 'reviewQueue', scope: VENDOR_REVIEW_SCOPE }, () => ({ items: reviewQueue(db, opts) }), opts);
      send(res, 200, body);
      return;
    }
    case 'submission': {
      const { scope, isReviewer } = eitherRole(db, key);
      const body = auditedRead(db, { key, operation: 'getSubmission', params: { id: param }, scope }, () => {
        const row = getSubmission(db, param);
        if (!canSee(authenticate(db, key), isReviewer, row)) throw new SubmissionNotFoundError(param);
        return { item: submissionView(db, row) };
      }, opts);
      send(res, 200, body);
      return;
    }
    case 'review': {
      const reviewer = requireAccess(db, { key, operation: 'reviewSubmission', params: { id: param }, scope: VENDOR_REVIEW_SCOPE });
      const body = await readJsonBody(req);
      onlyFields(body, REVIEW_FIELDS);
      send(res, 200, { item: submissionView(db, reviewSubmission(db, param, { reviewer, decision: body.decision, comment: body.comment ?? null }, opts)) });
      return;
    }
    case 'document': {
      const { scope, isReviewer } = eitherRole(db, key);
      const doc = auditedRead(db, { key, operation: 'getDocument', params: { id: param }, scope }, () => {
        const d = getDocumentContent(db, param);
        const owner = d && getSubmission(db, d.submission_id);
        if (!d || !canSee(authenticate(db, key), isReviewer, owner)) throw new SubmissionNotFoundError(param);
        return d;
      }, opts);
      const bytes = Buffer.from(doc.content);
      res.writeHead(200, {
        'Content-Type': doc.content_type,
        'Content-Length': bytes.length,
        // Always a download, never opened in the browser: an uploaded file cannot run as a page here.
        'Content-Disposition': `attachment; filename="${doc.filename.replace(/"/g, '')}"`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'no-store',
        'X-Content-SHA256': doc.sha256,
      });
      res.end(bytes);
      return;
    }
    default:
      throw new Error(`unhandled vendor route ${route.name}`);
  }
}
