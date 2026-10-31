// STORY-008 over real HTTP: an administrator changes system settings, and each change applies
// across the system on the very next use.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../server/db.js';
import { createApiClient } from '../server/api/clients.js';
import { createApiServer } from '../server/api/server.js';
import { bootstrapAdministrator, issueUserKey, createUser, grantRole } from '../server/access.js';
import { createWorkOrder } from '../server/workOrders.js';
import { purgeSubmissionIps } from '../server/publicRequests.js';
import { submitCompliance, reviewQueue } from '../server/vendorSubmissions.js';
import { SETTINGS } from '../server/settings.js';

async function start() {
  const db = openDatabase();
  const admin = bootstrapAdministrator(db, { email: 'jane.admin@herriman.example', display_name: 'Jane Admin' });
  const as = { actorUserId: admin.id };
  const adminKey = issueUserKey(db, admin.id, as).key;
  const sue = createUser(db, { email: 'sue@herriman.example', display_name: 'Sue Supervisor' }, as);
  grantRole(db, { userId: sue.id, roleId: 'supervisor' }, as);
  const sueKey = issueUserKey(db, sue.id, as).key;
  const server = createApiServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (method, path, { key = adminKey, body, headers = {} } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
  };
  const change = (settingKey, value, version) => call('PUT', `/settings/${settingKey}`, { body: { value }, headers: { 'If-Match': `"v${version}"` } });
  return { db, admin, sue, sueKey, call, change, stop: () => new Promise((resolve) => server.close(resolve)) };
}

let n = 0;
const citizen = () => ({ description: 'Pothole about a foot wide in the right-hand lane', location_text: 'Stand-in: 300 block of Example Way', category: 'pothole', submission_id: `settings-sub-${(n += 1).toString().padStart(4, '0')}` });

// ---------- reading and changing ----------

test('an administrator reads the settings, changes one with If-Match, and the change is audited with their user id', async (t) => {
  const { db, admin, call, change, stop } = await start();
  t.after(stop);
  const list = await call('GET', '/settings');
  assert.deepEqual(list.body.items.map((s) => s.key), Object.keys(SETTINGS));
  const one = await call('GET', '/settings/public.rate_limit_per_hour');
  assert.equal(one.headers.get('etag'), '"v0"');
  assert.deepEqual([one.body.item.value, one.body.item.is_default], [5, true]);

  const res = await change('public.rate_limit_per_hour', 20, 0);
  assert.equal(res.status, 200);
  assert.equal(res.body.changed, true);
  assert.equal(res.headers.get('etag'), '"v1"');
  assert.equal((await change('public.rate_limit_per_hour', 20, 1)).body.changed, false, 'the same value again changes nothing');

  const reset = await call('DELETE', '/settings/public.rate_limit_per_hour', { headers: { 'If-Match': '"v1"' } });
  assert.deepEqual([reset.status, reset.body.item.value, reset.body.item.is_default], [200, 5, true]);

  const trail = db.prepare("SELECT action, actor_user_id, occurred_at FROM audit_entries WHERE entity_type = 'setting' ORDER BY id").all();
  assert.deepEqual(trail.map((e) => e.action), ['set', 'reset']);
  assert.ok(trail.every((e) => e.actor_user_id === admin.id && !Number.isNaN(Date.parse(e.occurred_at))));
});

// ---------- AC1: a setting, once configured, applies across the system ----------

test('the public site rate limit applies to the very next submission', async (t) => {
  const { change, call, stop } = await start();
  t.after(stop);
  for (let i = 0; i < 2; i += 1) assert.equal((await call('POST', '/public/requests', { key: null, body: citizen() })).status, 201);
  await change('public.rate_limit_per_hour', 2, 0);
  const limited = await call('POST', '/public/requests', { key: null, body: citizen() });
  assert.equal(limited.status, 429, 'two already this hour: the third is refused');
  await change('public.rate_limit_per_hour', 10, 1);
  assert.equal((await call('POST', '/public/requests', { key: null, body: citizen() })).status, 201, 'raised again: accepted');
});

test('the default heat map cell size applies to the next heat map that does not choose one', async (t) => {
  const { db, change, call, stop } = await start();
  t.after(stop);
  await createWorkOrder(db, { title: 'Pothole', work_type: 'pothole', location_text: 'Stand-in', created_by: 'test' });
  const before = await call('GET', '/heat-maps');
  assert.equal(before.body.properties.params.cell_size_m, 250);
  await change('heat_maps.default_cell_size_m', 1000, 0);
  assert.equal((await call('GET', '/heat-maps')).body.properties.params.cell_size_m, 1000);
  assert.equal((await call('GET', '/heat-maps?cell_size_m=100')).body.properties.params.cell_size_m, 100, 'a request can still choose its own');
});

test('the vendor overdue rule and the IP retention period apply at once', async (t) => {
  const { db, change, stop } = await start();
  t.after(stop);
  const now = () => '2026-11-10T09:00:00.000Z';
  submitCompliance(db, { id: 'client-acme', name: 'Acme Municipal Software' },
    { requirementId: 'REQ-023', compliance: 'complies', technicalApproach: 'Bidirectional sync through the vendor GIS connector.' },
    { now: () => '2026-11-07T09:00:00.000Z' });
  assert.equal(reviewQueue(db, { now })[0].overdue, false, 'waiting 3 days, rule is 5');
  await change('vendor.review_overdue_days', 2, 0);
  assert.equal(reviewQueue(db, { now })[0].overdue, true, 'rule changed to 2: now overdue');

  db.prepare("INSERT INTO public_submission_log (ip_address, submitted_at, outcome) VALUES ('203.0.113.9', '2026-11-07T09:00:00.000Z', 'accepted')").run();
  assert.equal(purgeSubmissionIps(db, { now }), 0, 'kept: younger than 90 days');
  await change('public.ip_retention_days', 2, 0);
  assert.equal(purgeSubmissionIps(db, { now }), 1, 'retention changed to 2 days: removed');
});

// ---------- failure paths: configuration not saved, unauthorized access ----------

test('a change without If-Match (428), from an old copy (412), out of range (400) or to an unknown setting (404) changes nothing', async (t) => {
  const { db, call, change, stop } = await start();
  t.after(stop);
  assert.equal((await call('PUT', '/settings/public.rate_limit_per_hour', { body: { value: 9 } })).status, 428);
  await change('public.rate_limit_per_hour', 9, 0);
  const stale = await change('public.rate_limit_per_hour', 7, 0);
  assert.equal(stale.status, 412);
  assert.equal(stale.body.current.value, 9);
  const bad = await change('public.rate_limit_per_hour', 1000, 1);
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.problems, ['public.rate_limit_per_hour must be between 1 and 100']);
  assert.equal((await call('PUT', '/settings/public.rate_limit_per_hour', { body: { value: 3, colour: 'red' }, headers: { 'If-Match': '"v1"' } })).status, 400);
  assert.equal((await change('public.colour', 1, 0)).status, 404);
  assert.equal(db.prepare("SELECT value_json FROM system_settings WHERE key = 'public.rate_limit_per_hour'").get().value_json, '9');
});

test('if the database does not keep what was sent, the answer is 503 "configuration not saved" and nothing changes', async (t) => {
  const { db, change, call, stop } = await start();
  t.after(stop);
  // Simulate storage that silently changes the value as it is written.
  db.exec(`CREATE TRIGGER mangle AFTER INSERT ON system_settings BEGIN
             UPDATE system_settings SET value_json = '99' WHERE key = NEW.key; END;`);
  const res = await change('public.rate_limit_per_hour', 10, 0);
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'configuration_not_saved');
  db.exec('DROP TRIGGER mangle');
  const now = await call('GET', '/settings/public.rate_limit_per_hour');
  assert.deepEqual([now.body.item.value, now.body.item.version], [5, 0]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_entries WHERE entity_type = 'setting'").get().n, 0);
});

test('without settings:admin — or with only a system key — settings cannot be read or changed; refusals are audited', async (t) => {
  const { db, sue, sueKey, call, stop } = await start();
  t.after(stop);
  const system = createApiClient(db, { name: 'Config sync', scopes: ['settings:admin'], actor: 'admin-1' });
  assert.equal((await call('GET', '/settings', { key: sueKey })).status, 403, 'a supervisor cannot');
  assert.equal((await call('PUT', '/settings/public.rate_limit_per_hour', { key: sueKey, body: { value: 50 }, headers: { 'If-Match': '"v0"' } })).status, 403);
  const bySystem = await call('PUT', '/settings/public.rate_limit_per_hour', { key: system.key, body: { value: 50 }, headers: { 'If-Match': '"v0"' } });
  assert.equal(bySystem.status, 403);
  assert.match(bySystem.body.message, /must be made by a person/);
  assert.equal((await call('GET', '/settings', { key: null })).status, 401);

  const denied = db.prepare("SELECT actor_user_id, after_json FROM audit_entries WHERE entity_type = 'api_access' AND action = 'denied' ORDER BY id").all();
  assert.deepEqual(denied.map((d) => JSON.parse(d.after_json).operation), ['listSettings', 'setSetting', 'setSetting', 'listSettings'], 'the system key refusal is audited too');
  assert.equal(denied[0].actor_user_id, sue.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM system_settings').get().n, 0);
});

test('the OpenAPI contract lists every setting', async (t) => {
  const { call, stop } = await start();
  t.after(stop);
  const doc = (await call('GET', '/openapi.json', { key: null })).body;
  assert.deepEqual(doc.paths['/settings/{key}'].parameters[0].schema.enum, Object.keys(SETTINGS));
  assert.ok(doc.paths['/settings/{key}'].put.parameters.some((p) => p.name === 'If-Match' && p.required));
});
