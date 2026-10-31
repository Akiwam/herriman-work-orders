// STORY-012 demo: two vendors answer requirements, a city reviewer works the queue.
// Throwaway in-memory database, local port. Writes no files.
// Run with: npm run demo:vendor

import { openDatabase } from '../db.js';
import { createApiClient, VENDOR_SUBMIT_SCOPE, VENDOR_REVIEW_SCOPE } from '../api/clients.js';
import { createApiServer } from '../api/server.js';
import { submitCompliance } from '../vendorSubmissions.js';

const db = openDatabase(':memory:');
const acme = createApiClient(db, { name: 'Acme Municipal Software', scopes: [VENDOR_SUBMIT_SCOPE], actor: 'procurement.demo' });
const beta = createApiClient(db, { name: 'Beta Civic Systems', scopes: [VENDOR_SUBMIT_SCOPE], actor: 'procurement.demo' });
const reviewer = createApiClient(db, { name: 'City reviewer (Public Works)', scopes: [VENDOR_REVIEW_SCOPE], actor: 'procurement.demo' });
const server = createApiServer(db);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1/vendor`;
const call = async (method, path, key, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  return { status: res.status, body: await res.json() };
};
const line = () => console.log('-'.repeat(72));
const step = (n, text) => { line(); console.log(`STEP ${n} — ${text}`); line(); };
const pdf = Buffer.from('%PDF-1.7\n% stand-in technical approach for REQ-023\n%%EOF').toString('base64');

console.log('\nHerriman City Work Orders — STORY-012 demo (vendor compliance portal)');
console.log('Vendors and documents are made up for the demo.\n');

// An answer Beta sent eleven days ago, so the queue has something overdue to show.
submitCompliance(db, { id: beta.client.id, name: beta.client.name }, {
  requirementId: 'REQ-026', compliance: 'partially_complies',
  technicalApproach: 'Read access to the GIS database now; write-back planned for phase 2 using the edit service.',
}, { now: () => new Date(Date.now() - 11 * 24 * 60 * 60 * 1000).toISOString() });

step(1, 'A vendor lists the requirements it must answer');
const reqs = await call('GET', '/requirements', acme.key);
console.log(`  ${reqs.status}  ${reqs.body.items.length} requirements, e.g. ${reqs.body.items[3].id}: "${reqs.body.items[3].statement.slice(0, 70)}…"`);

step(2, 'Acme submits two answers, one with a PDF (AC1, AC3)');
const a1 = await call('POST', '/submissions', acme.key, {
  requirement_id: 'REQ-023', compliance: 'complies', submission_key: 'acme-req023-r1',
  technical_approach: 'Bidirectional GIS sync through our connector, with per-layer field mapping and retries.',
  documents: [{ filename: 'gis-approach.pdf', content_type: 'application/pdf', content_base64: pdf }],
});
console.log(`  ${a1.status}  REQ-023 revision ${a1.body.item.revision}  ${a1.body.item.status}  document ${a1.body.item.documents[0].filename} sha256 ${a1.body.item.documents[0].sha256.slice(0, 16)}…`);
const a2 = await call('POST', '/submissions', acme.key, {
  requirement_id: 'REQ-037', compliance: 'partially_complies',
  technical_approach: 'Public request form included; public activity map is on the roadmap.',
});
console.log(`  ${a2.status}  REQ-037 revision ${a2.body.item.revision}  ${a2.body.item.status}`);
const again = await call('POST', '/submissions', acme.key, {
  requirement_id: 'REQ-023', compliance: 'complies', submission_key: 'acme-req023-r1',
  technical_approach: 'Bidirectional GIS sync through our connector, with per-layer field mapping and retries.',
});
console.log(`  Re-sent with the same submission_key: ${again.status}  duplicate=${again.body.item.duplicate}`);

step(3, 'The reviewer works the queue — the old one is flagged overdue ("not reviewed")');
const queue = await call('GET', '/review-queue', reviewer.key);
for (const q of queue.body.items) {
  console.log(`  ${q.vendor_name.padEnd(24)} ${q.requirement_id}  rev ${q.revision}  waiting ${String(q.waiting_days).padStart(2)} days${q.overdue ? '  OVERDUE' : ''}`);
}

step(4, 'The reviewer approves one answer and asks for changes on another (AC2)');
const ok = await call('POST', `/submissions/${a1.body.item.id}/review`, reviewer.key, { decision: 'approve', comment: 'Meets REQ-023.' });
console.log(`  REQ-023 → ${ok.status} ${ok.body.item.status}`);
const changes = await call('POST', `/submissions/${a2.body.item.id}/review`, reviewer.key, { decision: 'request_changes', comment: 'Give a date for the public activity map.' });
console.log(`  REQ-037 → ${changes.status} ${changes.body.item.status}: "${changes.body.item.review_comment}"`);

step(5, 'Acme resubmits REQ-037 as revision 2, and it is approved');
const r2 = await call('POST', '/submissions', acme.key, {
  requirement_id: 'REQ-037', compliance: 'complies',
  technical_approach: 'Public request form and public activity map both included at go-live (map ships in release 2).',
});
console.log(`  ${r2.status}  REQ-037 revision ${r2.body.item.revision}  ${r2.body.item.status}`);
const ok2 = await call('POST', `/submissions/${r2.body.item.id}/review`, reviewer.key, { decision: 'approve' });
console.log(`  → ${ok2.body.item.status}`);

step(6, 'Keeping vendors apart (unauthorized access)');
const peek = await call('GET', `/submissions/${a1.body.item.id}`, beta.key);
console.log(`  Beta looks at Acme's submission: ${peek.status}  ${peek.body.error}`);
const selfReview = await call('POST', `/submissions/${a2.body.item.id}/review`, acme.key, { decision: 'approve' });
console.log(`  Acme tries to review: ${selfReview.status}  ${selfReview.body.error}`);

step(7, "Acme's compliance summary — every requirement, answered or not");
const summary = await call('GET', '/summary', acme.key);
console.log(`  totals: ${Object.entries(summary.body.totals).map(([k, v]) => `${v} ${k}`).join(', ')}`);
for (const i of summary.body.items.filter((x) => x.status !== 'not_answered')) console.log(`  ${i.requirement_id}  ${i.status}  (${i.compliance}, rev ${i.revision})`);

step(8, 'Audit trail of vendor submissions (AC3)');
for (const a of db.prepare("SELECT action, actor, after_json, occurred_at FROM audit_entries WHERE entity_type = 'vendor_submission' ORDER BY id").all()) {
  const s = JSON.parse(a.after_json);
  const what = s.revision ? `rev ${s.revision}` : (a.action === 'submit_duplicate' ? 'repeat, nothing stored' : 'refused, nothing stored');
  console.log(`  ${a.occurred_at}  ${a.action.padEnd(16)} ${s.requirement_id} ${what}  by ${a.actor}`);
}

await new Promise((resolve) => server.close(resolve));
line();
console.log('Demo finished. API stopped; nothing was written to disk.\n');
