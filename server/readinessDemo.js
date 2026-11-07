// STORY-010 demo: a project manager assesses whether the system is ready to go live by July 1, 2027.
//
// Two throwaway in-memory systems, nothing saved:
//   1. today's system, as it really is — stand-in GIS and Blue Stakes, no vendor connections, no
//      sign-offs yet. The honest verdict is "not ready", with every blocker named.
//   2. a fully prepared example — real connections that have worked recently, vendors exchanging
//      data, every manual item signed off — to show what "ready" looks like and that it is reachable.
// Run with: npm run demo:readiness

import { openDatabase } from './db.js';
import { bootstrapAdministrator, issueUserKey, createUser, grantRole } from './access.js';
import { createApiClient } from './api/clients.js';
import { createApiServer } from './api/server.js';
import { MANUAL_ITEMS } from './readiness.js';

const line = () => console.log('-'.repeat(72));
const step = (n, text) => { line(); console.log(`STEP ${n} — ${text}`); line(); };

async function system(connections) {
  const db = openDatabase(':memory:');
  const admin = bootstrapAdministrator(db, { email: 'jane.admin@herriman.example', display_name: 'Jane Admin' });
  const as = { actorUserId: admin.id };
  issueUserKey(db, admin.id, as);
  const person = (email, name, role) => {
    const user = createUser(db, { email, display_name: name }, as);
    grantRole(db, { userId: user.id, roleId: role }, as);
    return issueUserKey(db, user.id, as).key;
  };
  const pat = person('pat.pm@herriman.example', 'Pat Project-Manager', 'project_manager');
  const sam = person('sam@herriman.example', 'Sam Crew', 'field_crew');
  const server = createApiServer(db, { connections });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (method, path, key, body) => {
    const res = await fetch(`${base}${path}`, {
      method, headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return { db, pat, sam, call, close: () => server.close() };
}

function report(a) {
  console.log(`Verdict: ${a.verdict === 'ready' ? 'READY' : 'NOT READY'} — ${a.summary.passed} of ${a.summary.total} items pass; ${a.days_remaining} days to ${a.target_date}`);
  console.log(`Assessed by ${a.reviewer_email} (user ${a.reviewer_user_id.slice(0, 8)}…), ${a.started_at} → ${a.finished_at}`);
  for (const category of ['configuration', 'testing', 'data_conversion', 'schedule']) {
    const items = a.results.filter((r) => r.category === category);
    if (!items.length) continue;
    console.log(`\n  ${category.replace('_', ' ')}`);
    for (const r of items) console.log(`    ${r.passed ? 'PASS' : r.status === 'error' ? 'ERR ' : 'FAIL'}  ${r.title.slice(0, 100)}${r.passed ? '' : `\n          ${r.detail.slice(0, 110)}`}`);
  }
}

const today = await system({ gis: 'stand_in', bluestakes: 'stand_in' });
const prepared = await system({ gis: 'live', bluestakes: 'live' });
try {
  step(1, 'Pat (project manager) reads the readiness checklist');
  const list = (await today.call('GET', '/readiness', today.pat)).body;
  console.log(`Go-live target ${list.target_date}: ${list.automatic_checks.length} automatic checks and ${list.manual_items.length} items people confirm.`);
  await today.call('PUT', '/readiness/items/data_conversion.source_identified', today.pat, { status: 'done', note: 'Existing work orders identified in the current system (stand-in example)' });
  await today.call('PUT', '/readiness/items/testing.user_acceptance', today.pat, { status: 'in_progress', due_on: '2027-03-31', note: 'UAT sessions being booked with Public Works' });
  console.log('Pat records two items: source data identified (done), user acceptance testing (in progress, due 2027-03-31).');

  step(2, 'Pat assesses today\'s system — the honest answer');
  report((await today.call('POST', '/readiness/assessments', today.pat)).body.item);

  step(3, 'A configuration error is caught');
  today.db.prepare("INSERT INTO system_settings (key, value_json, version, updated_by, updated_at) VALUES ('public.rate_limit_per_hour', '{damaged', 1, 'x', ?)").run(new Date().toISOString());
  const broken = (await today.call('POST', '/readiness/assessments', today.pat)).body.item;
  console.log(`Settings check: ${broken.results.find((r) => r.key === 'configuration.settings_valid').detail}`);

  step(4, 'Sam (field crew) cannot run or change readiness');
  const refused = await today.call('POST', '/readiness/assessments', today.sam);
  console.log(`Sam runs an assessment → ${refused.status}  ${refused.body.message}`);

  step(5, 'A fully prepared example: every item complete → ready for launch');
  const at = new Date().toISOString();
  prepared.db.prepare("INSERT INTO gis_log (operation, attempt, outcome, started_at, finished_at, duration_ms) VALUES ('getAsset', 1, 'ok', ?, ?, 40)").run(at, at);
  prepared.db.prepare("INSERT INTO bluestakes_log (operation, attempt, outcome, started_at, finished_at, duration_ms) VALUES ('sendResponse', 1, 'ok', ?, ?, 40)").run(at, at);
  for (const vendor of ['Lama', 'SpryPoint', 'Madison AI']) {
    createApiClient(prepared.db, { name: vendor, actor: 'example' });
    prepared.db.prepare(`INSERT INTO api_request_log (request_id, received_at, finished_at, duration_ms, method, path, client_name, status)
                         VALUES (?, ?, ?, 12, 'GET', '/api/v1/work-orders', ?, 200)`).run(`example-${vendor}`, at, at, vendor);
  }
  for (const key of Object.keys(MANUAL_ITEMS)) await prepared.call('PUT', `/readiness/items/${key}`, prepared.pat, { status: 'done', note: 'Signed off at the go-live review (example)' });
  report((await prepared.call('POST', '/readiness/assessments', prepared.pat)).body.item);

  step(6, 'Trust: every assessment is on record with the reviewer and times');
  for (const a of (await today.call('GET', '/readiness/assessments', today.pat)).body.items) {
    console.log(`${a.started_at}  ${a.reviewer_email.padEnd(24)} ${a.verdict.padEnd(10)} ${a.summary.passed}/${a.summary.total} passed  (assessment ${a.id.slice(0, 8)}…)`);
  }
  line();
} finally {
  today.close();
  prepared.close();
}
