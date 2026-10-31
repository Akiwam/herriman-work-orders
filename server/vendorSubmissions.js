// Vendor compliance and technical approach submissions (STORY-012, REQ-022).
//
// A vendor answers one requirement at a time: does it comply, and how (technical approach). The
// submission and its audit entry are saved together, then read back and checked against the
// fingerprint of what was sent — a submission is only reported as received once it is known to
// be stored. City reviewers then approve it or request changes (see the review functions).

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inTransaction } from './db.js';
import { writeAudit, ValidationError, ConflictError, NotFoundError } from './workOrders.js';
import { getSetting } from './settings.js';

export const COMPLIANCE_VALUES = ['complies', 'partially_complies', 'does_not_comply'];
const APPROACH_LIMITS = [20, 10000];
const defaultNow = () => new Date().toISOString();

export class SubmissionNotFoundError extends NotFoundError {
  constructor(id) {
    super(id);
    this.name = 'SubmissionNotFoundError';
    this.message = `No vendor submission ${id}`;
  }
}

/** The stored submission could not be confirmed after saving. Nothing is reported as received. */
export class SubmissionNotStoredError extends Error {
  constructor(detail) {
    super(`The submission could not be confirmed as stored: ${detail}. Please submit it again.`);
    this.name = 'SubmissionNotStoredError';
  }
}

// ---------- the requirements vendors respond to ----------

let catalog = null;
export function loadRequirementCatalog(path = new URL('./vendor/requirements.json', import.meta.url)) {
  return JSON.parse(readFileSync(path, 'utf8')).requirements;
}
export function requirementCatalog() {
  catalog ??= loadRequirementCatalog();
  return catalog;
}
export function findRequirement(id) {
  return requirementCatalog().find((r) => r.id === id) ?? null;
}

// ---------- documents ----------

export const MAX_DOCUMENTS = 5;
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

// The only document types accepted, and how to recognise each from its first bytes — so a file is
// accepted for what it IS, not for what it is called.
const DOCUMENT_TYPES = {
  'application/pdf': { extension: '.pdf', looksRight: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    extension: '.docx', looksRight: (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04, // a zip, as .docx files are
  },
  'text/plain': { extension: '.txt', looksRight: (b) => !b.includes(0) && Buffer.from(b.toString('utf8'), 'utf8').equals(b) },
};

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** Strip any path and keep only plain characters, so a filename can never point anywhere. */
export function cleanFilename(name) {
  const base = String(name ?? '').split(/[\\/]/).pop().normalize('NFKC');
  return base.replace(/[^A-Za-z0-9 ._()-]/g, '_').replace(/^[ .]+/, '').slice(0, 120);
}

/** Check and decode the attached documents. Returns [{ filename, content_type, bytes, sha256 }]. */
function decodeDocuments(documents, problems) {
  if (documents === undefined || documents === null) return [];
  if (!Array.isArray(documents)) {
    problems.push('documents must be a list');
    return [];
  }
  if (documents.length > MAX_DOCUMENTS) problems.push(`at most ${MAX_DOCUMENTS} documents can be attached`);
  const decoded = [];
  documents.slice(0, MAX_DOCUMENTS).forEach((doc, i) => {
    const label = `documents[${i}]`;
    const type = DOCUMENT_TYPES[doc?.content_type];
    const filename = cleanFilename(doc?.filename);
    if (!type) {
      problems.push(`${label}: content_type must be one of: ${Object.keys(DOCUMENT_TYPES).join(', ')}`);
      return;
    }
    if (!filename.toLowerCase().endsWith(type.extension)) problems.push(`${label}: filename must end in ${type.extension}`);
    const b64 = typeof doc?.content_base64 === 'string' ? doc.content_base64 : '';
    if (!b64 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
      problems.push(`${label}: content_base64 must be base64-encoded file content`);
      return;
    }
    const bytes = Buffer.from(b64, 'base64');
    if (bytes.length === 0) problems.push(`${label}: the file is empty`);
    else if (bytes.length > MAX_DOCUMENT_BYTES) problems.push(`${label}: the file is larger than ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB`);
    else if (!type.looksRight(bytes)) problems.push(`${label}: the file content is not really ${type.extension}`);
    else decoded.push({ filename, content_type: doc.content_type, bytes, sha256: sha256(bytes) });
  });
  return decoded;
}

export function getDocuments(db, submissionId) {
  return db.prepare('SELECT id, filename, content_type, size_bytes, sha256, uploaded_at FROM vendor_documents WHERE submission_id = ? ORDER BY rowid')
    .all(submissionId).map((d) => ({ ...d }));
}

export function getDocumentContent(db, documentId) {
  return db.prepare('SELECT * FROM vendor_documents WHERE id = ?').get(String(documentId ?? '')) ?? null;
}

// ---------- submitting ----------

/** Fingerprint of exactly what the vendor submitted: requirement, answer, approach, and each document's bytes. */
export function contentFingerprint({ requirementId, compliance, technicalApproach, documentHashes = [] }) {
  return sha256(JSON.stringify([requirementId, compliance, technicalApproach, documentHashes]));
}

function validate(input) {
  const problems = [];
  if (!findRequirement(input?.requirementId)) problems.push(`requirement ${input?.requirementId ?? '(none)'} is not one vendors respond to`);
  if (!COMPLIANCE_VALUES.includes(input?.compliance)) problems.push(`compliance must be one of: ${COMPLIANCE_VALUES.join(', ')}`);
  const approach = typeof input?.technicalApproach === 'string' ? input.technicalApproach.trim() : null;
  if (approach === null) problems.push('technical_approach is required');
  else if (approach.length < APPROACH_LIMITS[0] || approach.length > APPROACH_LIMITS[1]) {
    problems.push(`technical_approach must be ${APPROACH_LIMITS[0]} to ${APPROACH_LIMITS[1]} characters`);
  }
  const key = input?.submissionKey;
  if (key !== undefined && key !== null && !(typeof key === 'string' && /^[\x21-\x7e]{8,100}$/.test(key))) {
    problems.push('submission_key must be 8 to 100 visible characters');
  }
  const documents = decodeDocuments(input?.documents, problems);
  if (problems.length) throw new ValidationError(problems);
  return { approach, documents };
}

function vendorCheck(vendor) {
  if (!vendor || typeof vendor.id !== 'string' || typeof vendor.name !== 'string') throw new TypeError('a vendor { id, name } is required');
}

export function getSubmission(db, id) {
  return db.prepare('SELECT * FROM vendor_submissions WHERE id = ?').get(String(id ?? '')) ?? null;
}

function latestRevision(db, vendorId, requirementId) {
  return db.prepare('SELECT * FROM vendor_submissions WHERE vendor_id = ? AND requirement_id = ? ORDER BY revision DESC LIMIT 1')
    .get(vendorId, requirementId) ?? null;
}

/** What the vendor gets back as proof of receipt, including each document's fingerprint. */
function receipt(db, row, duplicate) {
  return {
    id: row.id, requirement_id: row.requirement_id, revision: row.revision, status: row.status,
    submitted_at: row.submitted_at, content_sha256: row.content_sha256,
    documents: getDocuments(db, row.id).map(({ id, filename, size_bytes, sha256: hash }) => ({ id, filename, size_bytes, sha256: hash })),
    duplicate,
  };
}

/**
 * Store a vendor's compliance answer and technical approach for one requirement.
 *
 * - Invalid input: ValidationError, nothing stored.
 * - The same submission_key again: the original receipt, duplicate: true, nothing stored.
 * - A revision is already waiting for review, or already approved: ConflictError.
 * - Otherwise: stored as the next revision with status 'submitted', together with an audit entry
 *   (rolled back if the audit entry cannot be written), then read back and checked against the
 *   fingerprint. Only then is a receipt returned.
 *
 * `audit` is only replaceable so tests can prove the rollback.
 */
export function submitCompliance(db, vendor, input, { now = defaultNow, audit = writeAudit } = {}) {
  vendorCheck(vendor);
  // Every submission received is audited (AC3) — including ones refused or repeated, which store nothing.
  const auditReceived = (action, detail) => audit(db, {
    entityType: 'vendor_submission', entityId: String(input?.requirementId ?? 'unknown'), action, actor: vendor.name,
    after: { requirement_id: input?.requirementId ?? null, ...detail }, at: now(),
  });

  let checked;
  try {
    checked = validate(input);
  } catch (err) {
    if (err instanceof ValidationError) auditReceived('submit_rejected', { problems: err.problems });
    throw err;
  }
  const { approach, documents } = checked;
  const key = input.submissionKey ?? null;

  if (key) {
    const existing = db.prepare('SELECT * FROM vendor_submissions WHERE vendor_id = ? AND submission_key = ?').get(vendor.id, key);
    if (existing) {
      auditReceived('submit_duplicate', { original_submission_id: existing.id, submission_key: key });
      return receipt(db, existing, true);
    }
  }

  const documentHashes = documents.map((d) => d.sha256);
  const fingerprint = contentFingerprint({ requirementId: input.requirementId, compliance: input.compliance, technicalApproach: approach, documentHashes });
  const storeSubmission = () => inTransaction(db, () => {
    const latest = latestRevision(db, vendor.id, input.requirementId);
    if (latest?.status === 'submitted') throw new ConflictError(`Revision ${latest.revision} for ${input.requirementId} is still waiting for review.`);
    if (latest?.status === 'approved') throw new ConflictError(`Revision ${latest.revision} for ${input.requirementId} is already approved.`);

    const at = now();
    const row = {
      id: randomUUID(),
      vendor_id: vendor.id,
      vendor_name: vendor.name,
      requirement_id: input.requirementId,
      revision: (latest?.revision ?? 0) + 1,
      compliance: input.compliance,
      technical_approach: approach,
      content_sha256: fingerprint,
      submission_key: key,
      status: 'submitted',
      submitted_at: at,
      reviewed_by: null,
      reviewed_at: null,
      review_comment: null,
    };
    db.prepare(`INSERT INTO vendor_submissions (id, vendor_id, vendor_name, requirement_id, revision, compliance, technical_approach,
                content_sha256, submission_key, status, submitted_at, reviewed_by, reviewed_at, review_comment)
                VALUES (:id, :vendor_id, :vendor_name, :requirement_id, :revision, :compliance, :technical_approach,
                :content_sha256, :submission_key, :status, :submitted_at, :reviewed_by, :reviewed_at, :review_comment)`).run(row);
    const insertDoc = db.prepare(`INSERT INTO vendor_documents (id, submission_id, filename, content_type, size_bytes, sha256, content, uploaded_at)
                                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const d of documents) insertDoc.run(randomUUID(), row.id, d.filename, d.content_type, d.bytes.length, d.sha256, d.bytes, at);
    audit(db, {
      entityType: 'vendor_submission', entityId: row.id, action: 'submit', actor: vendor.name,
      after: { ...row, documents: documents.map((d) => ({ filename: d.filename, size_bytes: d.bytes.length, sha256: d.sha256 })) }, at,
    });

    // Read it back inside the transaction — text and every document's bytes: if what is stored is
    // not exactly what was sent, throwing here rolls the whole submission (and its audit entry) back.
    const stored = getSubmission(db, row.id);
    const storedHashes = db.prepare('SELECT content FROM vendor_documents WHERE submission_id = ? ORDER BY rowid').all(row.id)
      .map((d) => sha256(Buffer.from(d.content)));
    const check = stored && contentFingerprint({
      requirementId: stored.requirement_id, compliance: stored.compliance, technicalApproach: stored.technical_approach, documentHashes: storedHashes,
    });
    if (!stored || check !== fingerprint || stored.content_sha256 !== fingerprint) {
      throw new SubmissionNotStoredError('what was stored does not match what was sent');
    }
    return row.id;
  });

  let id;
  try {
    id = storeSubmission();
  } catch (err) {
    // The transaction has rolled back; record the refusal now so it survives (AC3).
    if (err instanceof ConflictError) auditReceived('submit_rejected', { problems: [err.message] });
    throw err;
  }

  // And confirm it survived the commit before telling the vendor it was received.
  const committed = getSubmission(db, id);
  if (!committed) throw new SubmissionNotStoredError('it was not found after saving');
  return receipt(db, committed, false);
}

// ---------- review (city reviewers) ----------

export const REVIEW_DECISIONS = ['approve', 'request_changes'];

// PLACEHOLDER: how long a submission may wait for review before it is flagged, until the city sets a rule.
export const REVIEW_OVERDUE_DAYS = 5; // built-in default; administrators change it with the setting vendor.review_overdue_days

/**
 * A city reviewer approves a submission or asks the vendor for changes. Audited.
 * - A comment is required when requesting changes (the vendor needs to know what to fix).
 * - A reviewer cannot review a submission from their own organisation (same API client).
 * - Only a submission that is waiting for review can be reviewed (ConflictError otherwise).
 */
export function reviewSubmission(db, id, { reviewer, decision, comment = null }, { now = defaultNow } = {}) {
  if (!reviewer || typeof reviewer.id !== 'string' || typeof reviewer.name !== 'string') throw new TypeError('a reviewer { id, name } is required');
  const problems = [];
  if (!REVIEW_DECISIONS.includes(decision)) problems.push(`decision must be one of: ${REVIEW_DECISIONS.join(', ')}`);
  if (comment !== null && typeof comment !== 'string') problems.push('comment must be text');
  const cleanComment = typeof comment === 'string' ? comment.trim() || null : null;
  if (decision === 'request_changes' && !cleanComment) problems.push('a comment is required when requesting changes');
  if (problems.length) throw new ValidationError(problems);

  return inTransaction(db, () => {
    const before = getSubmission(db, id);
    if (!before) throw new SubmissionNotFoundError(id);
    if (before.vendor_id === reviewer.id) throw new ConflictError('A submission cannot be reviewed by the organisation that submitted it.');
    if (before.status !== 'submitted') throw new ConflictError(`This submission was already reviewed (${before.status}).`);

    const at = now();
    const status = decision === 'approve' ? 'approved' : 'changes_requested';
    db.prepare('UPDATE vendor_submissions SET status = ?, reviewed_by = ?, reviewed_at = ?, review_comment = ? WHERE id = ?')
      .run(status, reviewer.name, at, cleanComment, before.id);
    const after = getSubmission(db, before.id);
    writeAudit(db, { entityType: 'vendor_submission', entityId: before.id, action: decision, actor: reviewer.name, before, after, at });
    return after;
  });
}

/** Every submission waiting for review, oldest first, with how long it has waited and whether it is overdue. */
export function reviewQueue(db, { now = defaultNow, overdueDays = getSetting(db, 'vendor.review_overdue_days') } = {}) {
  const nowMs = Date.parse(now());
  return db.prepare("SELECT * FROM vendor_submissions WHERE status = 'submitted' ORDER BY submitted_at, id").all().map((s) => {
    const waitingDays = Math.floor((nowMs - Date.parse(s.submitted_at)) / (24 * 60 * 60 * 1000));
    return {
      id: s.id, vendor_name: s.vendor_name, requirement_id: s.requirement_id, revision: s.revision, compliance: s.compliance,
      submitted_at: s.submitted_at, waiting_days: waitingDays, overdue: waitingDays > overdueDays,
    };
  });
}

/**
 * For one vendor, every requirement in the catalog and where its latest submission stands:
 * approved, waiting_for_review, changes_requested — or not_answered.
 */
export function vendorComplianceSummary(db, vendorId) {
  const latest = new Map(db.prepare(`SELECT * FROM vendor_submissions s WHERE vendor_id = ? AND revision =
      (SELECT MAX(revision) FROM vendor_submissions WHERE vendor_id = s.vendor_id AND requirement_id = s.requirement_id)`)
    .all(vendorId).map((s) => [s.requirement_id, s]));
  const label = { submitted: 'waiting_for_review', approved: 'approved', changes_requested: 'changes_requested' };
  const items = requirementCatalog().map((r) => {
    const s = latest.get(r.id);
    return {
      requirement_id: r.id, statement: r.statement,
      status: s ? label[s.status] : 'not_answered',
      compliance: s?.compliance ?? null, revision: s?.revision ?? null, review_comment: s?.review_comment ?? null,
    };
  });
  const totals = items.reduce((t, i) => ({ ...t, [i.status]: (t[i.status] ?? 0) + 1 }), {});
  return { vendor_id: vendorId, totals, items };
}
