// STORY-012 over real HTTP: two vendors and a city reviewer use the submission portal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { openDatabase } from '../server/db.js';
import { createApiClient, VENDOR_SUBMIT_SCOPE, VENDOR_REVIEW_SCOPE } from '../server/api/clients.js';
import { createApiServer } from '../server/api/server.js';
import { getSubmission } from '../server/vendorSubmissions.js';

async function start() {
  const db = openDatabase();
  const acme = createApiClient(db, { name: 'Acme Municipal Software', scopes: [VENDOR_SUBMIT_SCOPE], actor: 'admin-1' });
  const other = createApiClient(db, { name: 'Other Vendor Inc.', scopes: [VENDOR_SUBMIT_SCOPE], actor: 'admin-1' });
  const reviewer = createApiClient(db, { name: 'City reviewer', scopes: [VENDOR_REVIEW_SCOPE], actor: 'admin-1' });
  const madison = createApiClient(db, { name: 'Madison AI', actor: 'admin-1' });
  const server = createApiServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/vendor`;
  const call = async (method, path, { key, body } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const isJson = (res.headers.get('content-type') ?? '').startsWith('application/json');
    return { status: res.status, headers: res.headers, body: isJson ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  return { db, acme, other, reviewer, madison, call, stop: () => new Promise((resolve) => server.close(resolve)) };
}

const pdfBytes = Buffer.from('%PDF-1.7\n% stand-in technical approach\n%%EOF');
const submission = (extra = {}) => ({
  requirement_id: 'REQ-023',
  compliance: 'complies',
  technical_approach: 'Bidirectional GIS sync through a connector with per-layer field mapping and retries.',
  documents: [{ filename: 'approach.pdf', content_type: 'application/pdf', content_base64: pdfBytes.toString('base64') }],
  ...extra,
});

test('AC1 + AC2 + AC3 over HTTP: a vendor submits with a document, a reviewer approves, every step audited', async (t) => {
  const { db, acme, reviewer, call, stop } = await start();
  t.after(stop);

  const reqs = await call('GET', '/requirements', { key: acme.key });
  assert.equal(reqs.status, 200);
  assert.equal(reqs.body.items.length, 18);

  const sent = await call('POST', '/submissions', { key: acme.key, body: submission({ submission_key: 'acme-req023-0001' }) });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.item.status, 'submitted');
  assert.equal(sent.body.item.documents[0].sha256, createHash('sha256').update(pdfBytes).digest('hex'));
  const id = sent.body.item.id;
  assert.ok(getSubmission(db, id), 'AC1: stored in the system');

  const queue = await call('GET', '/review-queue', { key: reviewer.key });
  assert.deepEqual(queue.body.items.map((q) => q.id), [id]);

  const seen = await call('GET', `/submissions/${id}`, { key: reviewer.key });
  assert.equal(seen.body.item.technical_approach, submission().technical_approach);
  const file = await call('GET', `/documents/${seen.body.item.documents[0].id}`, { key: reviewer.key });
  assert.equal(file.status, 200);
  assert.deepEqual(file.body, pdfBytes, 'the reviewer downloads the exact bytes');
  assert.match(file.headers.get('content-disposition'), /^attachment; filename="approach.pdf"/);
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');

  const approved = await call('POST', `/submissions/${id}/review`, { key: reviewer.key, body: { decision: 'approve', comment: 'Meets REQ-023.' } });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.item.status, 'approved', 'AC2: reviewed and approved');

  const summary = await call('GET', '/summary', { key: acme.key });
  assert.equal(summary.body.items.find((i) => i.requirement_id === 'REQ-023').status, 'approved');
  assert.equal(summary.body.totals.not_answered, 17);

  const trail = db.prepare("SELECT action, actor FROM audit_entries WHERE entity_type = 'vendor_submission' AND entity_id = ? ORDER BY id").all(id).map((r) => `${r.action} by ${r.actor}`);
  assert.deepEqual(trail, ['submit by Acme Municipal Software', 'approve by City reviewer'], 'AC3');
});

test('a vendor cannot see another vendor\'s submission or documents — it looks the same as missing', async (t) => {
  const { acme, other, call, stop } = await start();
  t.after(stop);
  const sent = await call('POST', '/submissions', { key: acme.key, body: submission() });
  const docId = sent.body.item.documents[0].id;

  const peek = await call('GET', `/submissions/${sent.body.item.id}`, { key: other.key });
  const missing = await call('GET', '/submissions/no-such-id', { key: other.key });
  assert.equal(peek.status, 404);
  assert.equal(peek.body.error, missing.body.error);
  assert.equal((await call('GET', `/documents/${docId}`, { key: other.key })).status, 404);
  assert.equal((await call('GET', '/summary', { key: other.key })).body.totals.not_answered, 18, "another vendor's answers never show");
  assert.equal((await call('GET', `/submissions/${sent.body.item.id}`, { key: acme.key })).status, 200, 'the owner can see it');
});

test('unauthorized: no key 401, and each role is kept to its own endpoints (403), all audited', async (t) => {
  const { db, acme, reviewer, madison, call, stop } = await start();
  t.after(stop);
  const { body } = await call('POST', '/submissions', { key: acme.key, body: submission() });
  const id = body.item.id;

  assert.equal((await call('POST', '/submissions', { body: submission() })).status, 401);
  assert.equal((await call('POST', `/submissions/${id}/review`, { key: acme.key, body: { decision: 'approve' } })).status, 403, 'a vendor cannot review');
  assert.equal((await call('GET', '/review-queue', { key: acme.key })).status, 403, 'a vendor cannot see the queue');
  assert.equal((await call('POST', '/submissions', { key: reviewer.key, body: submission() })).status, 403, 'a reviewer cannot submit as a vendor');
  assert.equal((await call('GET', '/requirements', { key: madison.key })).status, 403, 'an unrelated system has no access');
  assert.equal(getSubmission(db, id).status, 'submitted', 'nothing changed');
  const denied = db.prepare("SELECT COUNT(*) AS n FROM audit_entries WHERE entity_type = 'api_access' AND action = 'denied'").get().n;
  assert.equal(denied, 5);
});

test('invalid data, unknown fields, conflicts and wrong methods get clear errors', async (t) => {
  const { acme, reviewer, call, stop } = await start();
  t.after(stop);
  const bad = await call('POST', '/submissions', { key: acme.key, body: { requirement_id: 'REQ-999', compliance: 'yes', technical_approach: 'short', colour: 'red' } });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.problems.includes('colour is not a field this endpoint accepts'));
  const disguised = await call('POST', '/submissions', {
    key: acme.key, body: submission({ documents: [{ filename: 'x.pdf', content_type: 'application/pdf', content_base64: Buffer.from('MZ evil').toString('base64') }] }),
  });
  assert.equal(disguised.status, 400);
  assert.match(disguised.body.problems[0], /not really \.pdf/);

  const { body } = await call('POST', '/submissions', { key: acme.key, body: submission() });
  assert.equal((await call('POST', '/submissions', { key: acme.key, body: submission() })).status, 409, 'already waiting for review');
  assert.equal((await call('POST', `/submissions/${body.item.id}/review`, { key: reviewer.key, body: { decision: 'request_changes' } })).status, 400, 'comment required');
  assert.equal((await call('POST', `/submissions/${body.item.id}/review`, { key: reviewer.key, body: { decision: 'approve' } })).status, 200);
  assert.equal((await call('POST', `/submissions/${body.item.id}/review`, { key: reviewer.key, body: { decision: 'approve' } })).status, 409, 'already reviewed');
  assert.equal((await call('DELETE', `/submissions/${body.item.id}`, { key: reviewer.key })).status, 405);
  assert.equal((await call('GET', '/nothing', { key: reviewer.key })).status, 404);
});

test('the OpenAPI contract documents the vendor endpoints with exactly the fields they accept', async (t) => {
  const { stop } = await start();
  t.after(stop);
  const { openApiDocument } = await import('../server/api/openapi.js');
  const { SUBMISSION_FIELDS, REVIEW_FIELDS } = await import('../server/api/vendorRoutes.js');
  const doc = openApiDocument();
  const bodyOf = (path) => doc.paths[path].post.requestBody.content['application/json'].schema;
  assert.deepEqual(Object.keys(bodyOf('/vendor/submissions').properties), SUBMISSION_FIELDS);
  assert.deepEqual(Object.keys(bodyOf('/vendor/submissions/{id}/review').properties), REVIEW_FIELDS);
  assert.equal(bodyOf('/vendor/submissions').additionalProperties, false);
  for (const p of ['/vendor/requirements', '/vendor/summary', '/vendor/review-queue', '/vendor/submissions/{id}', '/vendor/documents/{id}']) assert.ok(doc.paths[p].get, p);
});

test('a submission with several documents fits under the raised size limit; other endpoints keep the small limit', async (t) => {
  const { acme, reviewer, call, stop } = await start();
  t.after(stop);
  const big = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(900 * 1024, 0x41)]); // ~0.9 MB each
  const docs = [1, 2, 3].map((i) => ({ filename: `part-${i}.pdf`, content_type: 'application/pdf', content_base64: big.toString('base64') }));
  const sent = await call('POST', '/submissions', { key: acme.key, body: submission({ documents: docs }) });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.item.documents.length, 3);

  const huge = await call('POST', `/submissions/${sent.body.item.id}/review`, { key: reviewer.key, body: { decision: 'approve', comment: 'x'.repeat(70 * 1024) } });
  assert.equal(huge.status, 400, 'the review endpoint still caps bodies at 64 KB');
});
