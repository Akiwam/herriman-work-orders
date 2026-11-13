// STORY-018 demo: the integrations and readiness view, through a signed-in console session exactly as
// the screen calls it. Throwaway in-memory database and local port; nothing is saved.
// To see the screen itself: npm run console, sign in as Jane, open "Integrations & readiness".
// Run with: npm run demo:integrations

import { openDatabase } from './db.js';
import { bootstrapAdministrator, issueUserKey, createUser, grantRole } from './access.js';
import { createApiServer } from './api/server.js';
import { startSession } from './consoleSessions.js';
import { createGisClient, createGisLogger, createStandInGis, loadStandInAssets } from './gis.js';
import { createBlueStakesClient, createBlueStakesLogger, IntegrationError } from './bluestakes.js';
import { recordItem } from './readiness.js';

const db = openDatabase(':memory:');
const line = () => console.log('-'.repeat(78));
const step = (n, text) => { line(); console.log(`STEP ${n} — ${text}`); line(); };
const admin = bootstrapAdministrator(db, { email: 'jane.admin@herriman.example', display_name: 'Jane Admin' });
const as = { actorUserId: admin.id };
const person = (email, name, role) => {
  const u = createUser(db, { email, display_name: name }, as);
  grantRole(db, { userId: u.id, roleId: role }, as);
  return { ...u, token: startSession(db, issueUserKey(db, u.id, as).key).token };
};
const pat = person('pat@herriman.example', 'Pat Manager', 'project_manager');
const sam = person('sam@herriman.example', 'Sam Crew', 'field_crew');

// A stand-in GIS we can switch between answering, answering with the wrong shape, and being down.
const standIn = createStandInGis(loadStandInAssets());
let mode = 'ok';
const backend = {
  kind: 'stand-in',
  getChangesSince: async (cursor, auth) => {
    if (mode === 'down') throw new IntegrationError('connection refused (the stand-in GIS is switched off for this demo)');
    if (mode === 'odd') return { items: [] }; // a success, but not the shape GIS replies have
    return standIn.getChangesSince(cursor, auth);
  },
};
const gis = createGisClient(backend, { log: createGisLogger(db), timeoutMs: 1000, attempts: 2, delayMs: 10 });

const server = createApiServer(db, { gis, connections: { gis: 'stand_in', bluestakes: 'stand_in' } });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1/console`;
const call = async (method, path, token = pat.token) => {
  const res = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json() };
};
const showConnections = async () => {
  for (const i of (await call('GET', '/integrations')).body.items) {
    const extra = i.status === 'failing' ? `  ${i.error_class}, failing since ${i.failing_since}` : '';
    console.log(`  ${i.vendor.padEnd(20)} ${i.status.padEnd(13)} last success: ${(i.last_success_at ?? 'never').padEnd(24)}${extra}`);
  }
};

try {
  step(1, 'Pat (project manager) opens the view: nothing has been called yet');
  await showConnections();

  step(2, 'Real calls happen: GIS is checked, Blue Stakes answers once and then has an outage');
  console.log(`  Check now (GIS)                → ${(await call('POST', '/integrations/gis/check')).body.check.outcome}`);
  const bluestakes = createBlueStakesClient({
    kind: 'stand-in',
    sendResponse: async (t, r) => { if (t !== 'T-1') throw new IntegrationError('Blue Stakes did not accept the connection (stand-in outage)'); return { accepted: true, response_id: r.response_id }; },
  }, { log: createBlueStakesLogger(db), timeoutMs: 1000, attempts: 2, delayMs: 10 });
  await bluestakes.sendResponse('T-1', { response_id: 'r-1' });
  await bluestakes.sendResponse('T-2', { response_id: 'r-2' }).catch(() => {});
  console.log('  Blue Stakes: one response delivered, then one refused after 2 attempts');
  await showConnections();

  step(3, 'Failure paths: GIS answers with the wrong shape, then GIS is down');
  mode = 'odd';
  const odd = (await call('POST', '/integrations/gis/check')).body.check;
  console.log(`  Check now (GIS replies { items: [] }) → ${odd.outcome}: ${odd.error}`);
  mode = 'down';
  const down = (await call('POST', '/integrations/gis/check')).body.check;
  console.log(`  Check now (GIS switched off)          → ${down.outcome}: ${down.error}`);
  await showConnections();

  step(4, 'Trust: the status follows the next real call; nothing is a stored flag');
  mode = 'ok';
  console.log(`  GIS is back. Check now → ${(await call('POST', '/integrations/gis/check')).body.check.outcome}`);
  await showConnections();

  step(5, 'Readiness: each check with pass or fail and the evidence behind it');
  recordItem(db, 'testing.staff_trained', { status: 'done' }, as); // marked done, nothing behind it
  const run = await fetch(base.replace('/console', '/readiness/assessments'), { method: 'POST', headers: { Authorization: `Bearer ${pat.token}` } });
  console.log(`  Pat presses "Run assessment now" → ${run.status}`);
  const r = (await call('GET', '/integrations')).body.readiness;
  console.log(`  ${r.assessment ? 'Latest assessment found' : 'No assessment run yet'}: ${r.summary.passed} pass, ${r.summary.failed} fail, ${r.summary.no_evidence} no evidence, ${r.summary.not_run} not run`);
  for (const c of r.checks.filter((x) => ['configuration.gis_connection', 'testing.staff_trained', 'testing.user_acceptance'].includes(x.key))) {
    console.log(`  ${c.result.padEnd(11)} ${c.title.slice(0, 60).padEnd(60)} ${c.evidence}`);
  }

  step(6, 'Sam (field crew) is refused, and the refusal is recorded');
  console.log(`  Sam opens the view   → ${(await call('GET', '/integrations', sam.token)).status}`);
  console.log(`  Sam presses Check now → ${(await call('POST', '/integrations/gis/check', sam.token)).status}`);
  const denied = db.prepare("SELECT COUNT(*) AS n FROM audit_entries WHERE entity_type = 'api_access' AND action = 'denied' AND actor_user_id = ?").get(sam.id).n;
  console.log(`  Refusals recorded for Sam: ${denied}`);
  line();
} finally {
  server.close();
}
