// STORY-018 — the integrations and readiness view over HTTP, through a console session exactly as the
// screen calls it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../server/db.js';
import { bootstrapAdministrator, issueUserKey, createUser, grantRole } from '../server/access.js';
import { createApiServer } from '../server/api/server.js';
import { startSession } from '../server/consoleSessions.js';
import { createGisClient, createGisLogger, createStandInGis, loadStandInAssets } from '../server/gis.js';

async function start({ gisBackend = createStandInGis(loadStandInAssets()) } = {}) {
  const db = openDatabase();
  const admin = bootstrapAdministrator(db, { email: 'jane.admin@herriman.example', display_name: 'Jane Admin' });
  const as = { actorUserId: admin.id };
  const sessionFor = (userId) => startSession(db, issueUserKey(db, userId, as).key).token;
  const person = (email, name, role) => {
    const u = createUser(db, { email, display_name: name }, as);
    grantRole(db, { userId: u.id, roleId: role }, as);
    return { ...u, token: sessionFor(u.id) };
  };
  const pat = person('pat@herriman.example', 'Pat Manager', 'project_manager');
  const sam = person('sam@herriman.example', 'Sam Crew', 'field_crew');
  const gis = gisBackend && createGisClient(gisBackend, { log: createGisLogger(db), timeoutMs: 300, attempts: 2, delayMs: 1 });
  const server = createApiServer(db, { gis, connections: { gis: 'stand_in', bluestakes: 'stand_in' } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/console`;
  const call = async (method, path, token = pat.token) => {
    const res = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
  };
  return { db, pat, sam, call, stop: () => new Promise((resolve) => server.close(resolve)) };
}

test('a project manager sees every integration with its vendor, status and last success, and the readiness checks', async (t) => {
  const { call, stop } = await start();
  t.after(stop);
  const view = await call('GET', '/integrations');
  assert.equal(view.status, 200);
  assert.equal(view.headers.get('cache-control'), 'no-store', 'never served from a cache');
  assert.deepEqual(view.body.items.map((i) => [i.vendor, i.status, i.last_success_at]), [
    ['City GIS', 'never_called', null], ['Blue Stakes of Utah', 'never_called', null],
    ['Madison AI', 'never_called', null], ['Lama', 'never_called', null], ['SpryPoint', 'never_called', null],
  ]);
  assert.equal(view.body.items[0].connection, 'stand_in');
  assert.ok(view.body.readiness.checks.length > 10);
  assert.ok(view.body.readiness.checks.every((c) => c.evidence), 'every check says what is behind it, or that nothing is');
});

test('check now calls GIS for real, and the next view shows the result with who asked recorded', async (t) => {
  const { db, pat, call, stop } = await start();
  t.after(stop);
  const checked = await call('POST', '/integrations/gis/check');
  assert.deepEqual([checked.status, checked.body.check.outcome, checked.body.status.status], [200, 'ok', 'healthy']);
  const gis = (await call('GET', '/integrations')).body.items.find((i) => i.name === 'gis');
  assert.deepEqual([gis.status, gis.last_success_at], ['healthy', checked.body.check.finished_at]);
  const audit = db.prepare("SELECT actor_user_id FROM audit_entries WHERE entity_type = 'integration_check'").get();
  assert.equal(audit.actor_user_id, pat.id);
});

test('when GIS is down, check now flags it as failing with the error class and the time it began', async (t) => {
  const down = { kind: 'stand-in', getChangesSince: async () => { throw new Error('connection refused'); } };
  const { call, stop } = await start({ gisBackend: down });
  t.after(stop);
  const checked = await call('POST', '/integrations/gis/check');
  assert.deepEqual([checked.status, checked.body.check.outcome], [200, 'error'], 'the check worked; what it found is a failure');
  const gis = (await call('GET', '/integrations')).body.items.find((i) => i.name === 'gis');
  assert.deepEqual([gis.status, gis.error_class, gis.last_success_at], ['failing', 'error', null]);
  assert.ok(gis.failing_since);
});

test('field crew are refused the view and check now, and each refusal is recorded with who tried', async (t) => {
  const { db, sam, call, stop } = await start();
  t.after(stop);
  assert.equal((await call('GET', '/integrations', sam.token)).status, 403);
  assert.equal((await call('POST', '/integrations/gis/check', sam.token)).status, 403);
  const denied = db.prepare("SELECT actor_user_id, after_json FROM audit_entries WHERE entity_type = 'api_access' AND action = 'denied'").all()
    .map((r) => [r.actor_user_id, JSON.parse(r.after_json).operation]);
  assert.deepEqual(denied, [[sam.id, 'consoleIntegrations'], [sam.id, 'consoleCheckIntegration']]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM integration_checks').get().n, 0);
});

test('check now is refused for integrations with no read-only call, unknown names, a missing GIS and the wrong method', async (t) => {
  const { call, stop } = await start({ gisBackend: null });
  t.after(stop);
  const bs = await call('POST', '/integrations/bluestakes/check');
  assert.equal(bs.status, 400);
  assert.match(bs.body.message, /no read-only call/);
  assert.match((await call('POST', '/integrations/gis/check')).body.message, /not connected/);
  assert.equal((await call('POST', '/integrations/nowhere/check')).status, 404);
  assert.equal((await call('GET', '/integrations/gis/check')).status, 405);
  assert.equal((await call('POST', '/integrations')).status, 405);
  assert.equal((await call('GET', '/integrations', 'hws_not-a-session')).status, 401);
});
