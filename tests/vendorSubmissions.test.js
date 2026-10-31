// STORY-012 — vendor compliance and technical approach submissions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { openDatabase } from '../server/db.js';
import { ValidationError, ConflictError } from '../server/workOrders.js';
import {
  requirementCatalog, submitCompliance, getSubmission, contentFingerprint, COMPLIANCE_VALUES, SubmissionNotStoredError,
} from '../server/vendorSubmissions.js';
import { writeAudit } from '../server/workOrders.js';

const ACME = { id: 'client-acme', name: 'Acme Municipal Software' };
const OTHER = { id: 'client-other', name: 'Other Vendor Inc.' };
const approach = 'Bidirectional sync through the vendor GIS connector, with field mapping configured per asset layer.';
const answer = (extra = {}) => ({ requirementId: 'REQ-023', compliance: 'complies', technicalApproach: approach, ...extra });
const vendorAudits = (db) => db.prepare("SELECT * FROM audit_entries WHERE entity_type = 'vendor_submission' ORDER BY id").all();
const count = (db) => db.prepare('SELECT COUNT(*) AS n FROM vendor_submissions').get().n;

// ---------- the requirements catalog ----------

test('the requirements catalog has exactly the requirement ids the plan\'s stories reference', () => {
  const plan = JSON.parse(readFileSync(new URL('../.colaberry/plan.json', import.meta.url), 'utf8'));
  const referenced = [...new Set(plan.stories.flatMap((s) => s.fulfills ?? []))].sort();
  const catalogued = requirementCatalog().map((r) => r.id).sort();
  assert.deepEqual(catalogued, referenced);
  for (const r of requirementCatalog()) {
    assert.ok(r.statement.length > 10, `${r.id} has a statement`);
    assert.ok(['FUNC', 'NFR', 'SAFE', 'CONSTRAINT'].includes(r.kind), `${r.id} kind`);
  }
});

// ---------- AC1 + AC3: a submission is stored, and audited ----------

test('AC1 + AC3: a compliance submission is stored, audited, and confirmed with a fingerprint', () => {
  const db = openDatabase();
  const r = submitCompliance(db, ACME, answer());
  assert.equal(r.duplicate, false);
  assert.equal(r.requirement_id, 'REQ-023');
  assert.equal(r.revision, 1);
  assert.equal(r.status, 'submitted');
  assert.equal(r.content_sha256, contentFingerprint({ requirementId: 'REQ-023', compliance: 'complies', technicalApproach: approach }));

  const stored = getSubmission(db, r.id);
  assert.equal(stored.vendor_name, 'Acme Municipal Software');
  assert.equal(stored.compliance, 'complies');
  assert.equal(stored.technical_approach, approach);

  const [audit] = vendorAudits(db);
  assert.equal(audit.action, 'submit');
  assert.equal(audit.actor, 'Acme Municipal Software');
  assert.equal(JSON.parse(audit.after_json).requirement_id, 'REQ-023');
});

test('the same submission_key twice stores one submission; the repeat is audited as a duplicate', () => {
  const db = openDatabase();
  const first = submitCompliance(db, ACME, answer({ submissionKey: 'acme-req023-001' }));
  const again = submitCompliance(db, ACME, answer({ submissionKey: 'acme-req023-001' }));
  assert.equal(again.duplicate, true);
  assert.equal(again.id, first.id);
  assert.equal(count(db), 1);
  const audits = vendorAudits(db);
  assert.deepEqual(audits.map((a) => a.action), ['submit', 'submit_duplicate'], 'AC3: every submission received is in the audit trail');
  assert.equal(JSON.parse(audits[1].after_json).original_submission_id, first.id);
});

test('two vendors may answer the same requirement independently', () => {
  const db = openDatabase();
  submitCompliance(db, ACME, answer());
  const other = submitCompliance(db, OTHER, answer({ compliance: 'partially_complies' }));
  assert.equal(other.revision, 1);
  assert.equal(count(db), 2);
});

// ---------- failure path: vendor submission is not stored ----------

test('an invalid submission is refused with every problem listed, and nothing is stored', () => {
  const db = openDatabase();
  assert.throws(() => submitCompliance(db, ACME, {
    requirementId: 'REQ-999', compliance: 'yes', technicalApproach: 'too short', submissionKey: 'x',
  }), (err) => {
    assert.ok(err instanceof ValidationError);
    for (const p of ['requirement REQ-999 is not one vendors respond to', `compliance must be one of: ${COMPLIANCE_VALUES.join(', ')}`,
      'technical_approach must be 20 to 10000 characters', 'submission_key must be 8 to 100 visible characters']) {
      assert.ok(err.problems.includes(p), `missing problem: ${p}`);
    }
    return true;
  });
  assert.throws(() => submitCompliance(db, ACME, answer({ technicalApproach: undefined })), /technical_approach is required/);
  assert.equal(count(db), 0, 'nothing is stored');
  const audits = vendorAudits(db);
  assert.deepEqual(audits.map((a) => [a.action, a.actor]), [['submit_rejected', ACME.name], ['submit_rejected', ACME.name]],
    'AC3: refused submissions are still in the audit trail, with the reasons');
  assert.ok(JSON.parse(audits[0].after_json).problems.includes('requirement REQ-999 is not one vendors respond to'));
});

test('a submission refused because one is already waiting for review is audited as rejected', () => {
  const db = openDatabase();
  submitCompliance(db, ACME, answer());
  assert.throws(() => submitCompliance(db, ACME, answer({ compliance: 'partially_complies' })), ConflictError);
  const last = vendorAudits(db).at(-1);
  assert.equal(last.action, 'submit_rejected');
  assert.match(JSON.parse(last.after_json).problems[0], /still waiting for review/);
});

test('if the audit entry cannot be written, the submission is not stored either', () => {
  const db = openDatabase();
  const failingAudit = () => { throw new Error('audit store unavailable'); };
  assert.throws(() => submitCompliance(db, ACME, answer(), { audit: failingAudit }), /audit store unavailable/);
  assert.equal(count(db), 0, 'no submission without its audit entry');
});

test('if what was stored does not match what was sent, nothing is kept and the vendor is told', () => {
  const db = openDatabase();
  // Simulate the store changing the text on the way in (e.g. truncation), between insert and read-back.
  const corruptingAudit = (d, entry) => {
    d.prepare('UPDATE vendor_submissions SET technical_approach = substr(technical_approach, 1, 30) WHERE id = ?').run(entry.entityId);
    writeAudit(d, entry);
  };
  assert.throws(() => submitCompliance(db, ACME, answer(), { audit: corruptingAudit }), (err) => err instanceof SubmissionNotStoredError
    && /does not match what was sent/.test(err.message) && /submit it again/.test(err.message));
  assert.equal(count(db), 0, 'the mismatched submission was rolled back');
  assert.equal(vendorAudits(db).length, 0);
  assert.equal(submitCompliance(db, ACME, answer()).status, 'submitted', 'submitting again works');
});

test('a second revision cannot be sent while one is waiting for review', () => {
  const db = openDatabase();
  submitCompliance(db, ACME, answer());
  assert.throws(() => submitCompliance(db, ACME, answer({ compliance: 'partially_complies' })), ConflictError);
  assert.equal(count(db), 1);
});

// ---------- documents ----------

const b64 = (data) => Buffer.from(data).toString('base64');
const pdf = (name = 'approach.pdf', body = '%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF') => ({ filename: name, content_type: 'application/pdf', content_base64: b64(body) });
const docx = () => ({
  filename: 'compliance-matrix.docx',
  content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  content_base64: b64(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('stand-in docx body')])),
});
const txt = () => ({ filename: 'notes.txt', content_type: 'text/plain', content_base64: b64('Plain-text notes on the approach.') });
const docCount = (db) => db.prepare('SELECT COUNT(*) AS n FROM vendor_documents').get().n;

test('AC1: documents are stored with the submission, fingerprinted, and listed on the receipt', async () => {
  const db = openDatabase();
  const r = submitCompliance(db, ACME, answer({ documents: [pdf(), docx(), txt()] }));
  assert.deepEqual(r.documents.map((d) => d.filename), ['approach.pdf', 'compliance-matrix.docx', 'notes.txt']);
  const { getDocuments, getDocumentContent } = await import('../server/vendorSubmissions.js');
  const stored = getDocuments(db, r.id);
  assert.equal(stored.length, 3);
  const content = getDocumentContent(db, stored[0].id);
  assert.equal(Buffer.from(content.content).toString('latin1').slice(0, 5), '%PDF-', 'the exact bytes are kept');
  const { createHash } = await import('node:crypto');
  assert.equal(stored[0].sha256, createHash('sha256').update(Buffer.from(content.content)).digest('hex'));
  const audit = JSON.parse(vendorAudits(db)[0].after_json);
  assert.deepEqual(audit.documents.map((d) => d.filename), ['approach.pdf', 'compliance-matrix.docx', 'notes.txt'], 'the audit lists the documents (not their bytes)');
  assert.ok(!vendorAudits(db)[0].after_json.includes(pdf().content_base64));
});

test('a document of the wrong type, a disguised file, an empty or oversized file, or too many files is refused — nothing stored', async () => {
  const db = openDatabase();
  const { MAX_DOCUMENT_BYTES } = await import('../server/vendorSubmissions.js');
  const cases = [
    [{ filename: 'run.exe', content_type: 'application/x-msdownload', content_base64: b64('MZ') }, /content_type must be one of/],
    [{ ...pdf(), content_base64: b64('MZ\x90\x00 this is an executable') }, /not really \.pdf/],
    [{ ...pdf(), filename: 'approach.docx' }, /filename must end in \.pdf/],
    [{ ...txt(), content_base64: b64(Buffer.from([0x68, 0x00, 0x69])) }, /not really \.txt/],
    [{ ...pdf(), content_base64: '' }, /content_base64 must be base64/],
    [{ ...pdf(), content_base64: 'not base64!!' }, /content_base64 must be base64/],
    [{ ...pdf(), content_base64: b64(Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(MAX_DOCUMENT_BYTES)])) }, /larger than 5 MB/],
  ];
  for (const [doc, expected] of cases) {
    assert.throws(() => submitCompliance(db, ACME, answer({ documents: [doc] })), (err) => err instanceof ValidationError && err.problems.some((p) => expected.test(p)), String(expected));
  }
  assert.throws(() => submitCompliance(db, ACME, answer({ documents: [pdf('1.pdf'), pdf('2.pdf'), pdf('3.pdf'), pdf('4.pdf'), pdf('5.pdf'), pdf('6.pdf')] })), /at most 5 documents/);
  assert.throws(() => submitCompliance(db, ACME, answer({ documents: 'approach.pdf' })), /documents must be a list/);
  assert.equal(count(db), 0);
  assert.equal(docCount(db), 0);
});

test('file names are cleaned so they can never point anywhere', async () => {
  const { cleanFilename } = await import('../server/vendorSubmissions.js');
  assert.equal(cleanFilename('../../etc/passwd.pdf'), 'passwd.pdf');
  assert.equal(cleanFilename('C:\\Users\\x\\Approach v2.pdf'), 'Approach v2.pdf');
  assert.equal(cleanFilename('...hidden.pdf'), 'hidden.pdf');
  assert.equal(cleanFilename('weird<>|name?.pdf'), 'weird___name_.pdf');
});

test('if a document cannot be saved, the submission is not saved either', () => {
  const db = openDatabase();
  db.exec('DROP TABLE vendor_documents'); // the document store is gone
  assert.throws(() => submitCompliance(db, ACME, answer({ documents: [pdf()] })));
  assert.equal(count(db), 0, 'no submission without its documents');
  assert.equal(vendorAudits(db).length, 0);
});

test('a change to a stored document is caught by the fingerprint check and rolled back', () => {
  const db = openDatabase();
  const tampering = (d, entry) => {
    d.prepare("UPDATE vendor_documents SET content = X'255044462D00' WHERE submission_id = ?").run(entry.entityId);
    writeAudit(d, entry);
  };
  assert.throws(() => submitCompliance(db, ACME, answer({ documents: [pdf()] }), { audit: tampering }), SubmissionNotStoredError);
  assert.equal(count(db), 0);
  assert.equal(docCount(db), 0);
});

// ---------- review (AC2, and "technical approach is not reviewed") ----------

const REVIEWER = { id: 'client-city', name: 'City reviewer (Public Works)' };

test('AC2: a technical approach is reviewed and approved, and the approval is audited', async () => {
  const db = openDatabase();
  const { reviewSubmission } = await import('../server/vendorSubmissions.js');
  const r = submitCompliance(db, ACME, answer());
  const approved = reviewSubmission(db, r.id, { reviewer: REVIEWER, decision: 'approve', comment: 'Meets the GIS requirement.' });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.reviewed_by, 'City reviewer (Public Works)');
  assert.ok(approved.reviewed_at);
  assert.equal(getSubmission(db, r.id).status, 'approved');

  const audit = vendorAudits(db).find((a) => a.action === 'approve');
  assert.equal(audit.actor, 'City reviewer (Public Works)');
  assert.equal(JSON.parse(audit.before_json).status, 'submitted');
  assert.equal(JSON.parse(audit.after_json).status, 'approved');
});

test('requesting changes needs a comment; the vendor then resubmits as revision 2, and revision 1 is kept', async () => {
  const db = openDatabase();
  const { reviewSubmission } = await import('../server/vendorSubmissions.js');
  const r1 = submitCompliance(db, ACME, answer({ compliance: 'partially_complies' }));
  assert.throws(() => reviewSubmission(db, r1.id, { reviewer: REVIEWER, decision: 'request_changes' }), /a comment is required/);
  reviewSubmission(db, r1.id, { reviewer: REVIEWER, decision: 'request_changes', comment: 'Explain how write-back to GIS is handled.' });

  const r2 = submitCompliance(db, ACME, answer({ technicalApproach: `${approach} Write-back uses the GIS edit service with retries.` }));
  assert.equal(r2.revision, 2);
  assert.equal(getSubmission(db, r1.id).status, 'changes_requested', 'revision 1 is kept with its review');
  assert.equal(getSubmission(db, r1.id).review_comment, 'Explain how write-back to GIS is handled.');
  assert.equal(reviewSubmission(db, r2.id, { reviewer: REVIEWER, decision: 'approve' }).status, 'approved');
  assert.throws(() => submitCompliance(db, ACME, answer()), /already approved/);
});

test('a reviewer cannot review their own organisation\'s submission, or review one twice', async () => {
  const db = openDatabase();
  const { reviewSubmission, SubmissionNotFoundError } = await import('../server/vendorSubmissions.js');
  const r = submitCompliance(db, ACME, answer());
  assert.throws(() => reviewSubmission(db, r.id, { reviewer: ACME, decision: 'approve' }), /cannot be reviewed by the organisation that submitted it/);
  reviewSubmission(db, r.id, { reviewer: REVIEWER, decision: 'approve' });
  assert.throws(() => reviewSubmission(db, r.id, { reviewer: REVIEWER, decision: 'request_changes', comment: 'x' }), /already reviewed/);
  assert.throws(() => reviewSubmission(db, 'no-such-id', { reviewer: REVIEWER, decision: 'approve' }), (e) => e instanceof SubmissionNotFoundError && e.message === 'No vendor submission no-such-id');
  assert.throws(() => reviewSubmission(db, r.id, { reviewer: REVIEWER, decision: 'maybe' }), /decision must be one of/);
});

test('"not reviewed": the review queue lists everything waiting, oldest first, and flags overdue items', async () => {
  const db = openDatabase();
  const { reviewQueue, reviewSubmission } = await import('../server/vendorSubmissions.js');
  submitCompliance(db, ACME, answer({ requirementId: 'REQ-026' }), { now: () => '2026-10-20T09:00:00.000Z' });
  const recent = submitCompliance(db, OTHER, answer(), { now: () => '2026-10-29T09:00:00.000Z' });
  const reviewed = submitCompliance(db, ACME, answer(), { now: () => '2026-10-21T09:00:00.000Z' });
  reviewSubmission(db, reviewed.id, { reviewer: REVIEWER, decision: 'approve' });

  const queue = reviewQueue(db, { now: () => '2026-10-30T09:00:00.000Z' });
  assert.deepEqual(queue.map((q) => [q.vendor_name, q.requirement_id, q.waiting_days, q.overdue]), [
    ['Acme Municipal Software', 'REQ-026', 10, true],
    ['Other Vendor Inc.', 'REQ-023', 1, false],
  ]);
  assert.ok(!queue.some((q) => q.id === reviewed.id), 'reviewed submissions leave the queue');
  assert.equal(queue[1].id, recent.id);
});

test('the compliance summary shows every requirement for a vendor, including the ones not answered yet', async () => {
  const db = openDatabase();
  const { vendorComplianceSummary, reviewSubmission } = await import('../server/vendorSubmissions.js');
  const a = submitCompliance(db, ACME, answer());
  reviewSubmission(db, a.id, { reviewer: REVIEWER, decision: 'approve' });
  submitCompliance(db, ACME, answer({ requirementId: 'REQ-026' }));

  const summary = vendorComplianceSummary(db, ACME.id);
  assert.equal(summary.items.length, 18);
  assert.equal(summary.items.find((i) => i.requirement_id === 'REQ-023').status, 'approved');
  assert.equal(summary.items.find((i) => i.requirement_id === 'REQ-026').status, 'waiting_for_review');
  assert.deepEqual(summary.totals, { not_answered: 16, approved: 1, waiting_for_review: 1 });
  assert.equal(vendorComplianceSummary(db, OTHER.id).totals.not_answered, 18, 'another vendor\'s answers are not counted');
});

test('a submission needs a vendor identity', () => {
  const db = openDatabase();
  assert.throws(() => submitCompliance(db, null, answer()), /vendor \{ id, name \} is required/);
});
