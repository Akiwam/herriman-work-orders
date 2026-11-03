// STORY-010 over real HTTP: a project manager works through the readiness checklist and runs assessments.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../server/db.js';
import { createApiClient } from '../server/api/clients.js';
import { createApiServer } from '../server/api/server.js';
import { bootstrapAdministrator, issueUserKey, createUser, grantRole } from '../server/access.js';
import { MANUAL_ITEMS, AUTOMATIC_CHECKS } from '../server/readiness.js';

async function start({ connections = { gis: 'stand_in', bluestakes: 'stand_in' } } = {}) {
  const db = openDatabase();
  const admin = bootstrapAdministrator(db, { email: 'jane.admin@herriman.example', display_name: 'Jane Admin' });
  const as = { actorUserId: admin.id };
  issueUserKey(db, admin.id, as);
  const person = (email, name, role) => {
    const user = createUser(db, { email, display_name: name }, as);
    grantRole(db, { userId: user.id, roleId: role }, as);
    return { ...user, key: issueUserKey(db, user.id, as).key };
  };
  const pat = person('pat.pm@herriman.example', 'Pat Project-Manager', 'project_manager');
  const sam = person('sam@herriman.example', 'Sam Crew', 'field_crew');
  const server = createApiServer(db, { connections });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (method, path, { key = pat.key, body, headers = {} } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
  };
  return { db, pat, sam, call, stop: () => new Promise((resolve) => server.close(resolve)) };
}

test('a project manager reads the checklist and records items, each audited with their user id', async (t) => {
  const { db, pat, call, stop } = await start();
  t.after(stop);
  const list = await call('GET', '/readiness');
  assert.equal(list.status, 200);
  assert.equal(list.body.target_date, '2027-07-01');
  assert.equal(list.body.manual_items.length, Object.keys(MANUAL_ITEMS).length);
  assert.equal(list.body.automatic_checks.length, Object.keys(AUTOMATIC_CHECKS).length);

  const rec = await call('PUT', '/readiness/items/data_conversion.source_identified', { body: { status: 'done', note: 'Old system: Cartegraph export, 41,200 records' } });
  assert.deepEqual([rec.status, rec.body.changed, rec.body.item.passed], [200, true, true]);
  const bad = await call('PUT', '/readiness/items/data_conversion.source_identified', { body: { status: 'finished' } });
  assert.equal(bad.status, 400);
  assert.equal((await call('PUT', '/readiness/items/testing.vibes', { body: { status: 'done' } })).status, 404);

  const [entry] = db.prepare("SELECT actor_user_id, occurred_at FROM audit_entries WHERE entity_type = 'readiness_item'").all();
  assert.equal(entry.actor_user_id, pat.id);
});

test('an assessment over HTTP gives the honest verdict, is kept with the reviewer and times, and can be read back', async (t) => {
  const { db, pat, call, stop } = await start();
  t.after(stop);
  const run = await call('POST', '/readiness/assessments');
  assert.equal(run.status, 201);
  const a = run.body.item;
  assert.equal(a.verdict, 'not_ready');
  assert.ok(a.summary.blockers.includes('configuration.gis_connection'), 'started with a stand-in GIS: a blocker');
  assert.deepEqual([a.reviewer_user_id, a.reviewer_email], [pat.id, 'pat.pm@herriman.example']);
  assert.ok(Date.parse(a.started_at) <= Date.parse(a.finished_at));
  assert.equal(run.headers.get('location'), `/api/v1/readiness/assessments/${a.id}`);

  const one = await call('GET', `/readiness/assessments/${a.id}`);
  assert.deepEqual([one.status, one.body.item.verdict, one.body.item.results.length], [200, 'not_ready', a.results.length]);
  assert.equal((await call('GET', '/readiness/assessments')).body.items.length, 1);
  assert.equal((await call('GET', '/readiness/assessments/nope')).status, 404);

  const entry = db.prepare("SELECT actor_user_id FROM audit_entries WHERE entity_type = 'readiness_assessment'").get();
  assert.equal(entry.actor_user_id, pat.id);
});

test('the same Idempotency-Key twice gives one assessment', async (t) => {
  const { db, call, stop } = await start();
  t.after(stop);
  const first = await call('POST', '/readiness/assessments', { headers: { 'Idempotency-Key': 'review-2026-11-02' } });
  const again = await call('POST', '/readiness/assessments', { headers: { 'Idempotency-Key': 'review-2026-11-02' } });
  assert.deepEqual([first.status, again.status], [201, 200]);
  assert.equal(again.headers.get('idempotent-replayed'), 'true');
  assert.equal(again.body.item.id, first.body.item.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM readiness_assessments').get().n, 1);
});

test('if the assessment cannot be recorded, the answer is 503 and no result is given', async (t) => {
  const { db, call, stop } = await start();
  t.after(stop);
  db.exec(`CREATE TRIGGER no_records BEFORE INSERT ON readiness_assessments BEGIN SELECT RAISE(ABORT, 'disk full'); END;`);
  const res = await call('POST', '/readiness/assessments');
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'assessment_not_saved');
  assert.equal(res.body.item, undefined);
});

test('without readiness:review — or with only a system key — readiness cannot be read, recorded or assessed; refusals are audited', async (t) => {
  const { db, sam, call, stop } = await start();
  t.after(stop);
  const system = createApiClient(db, { name: 'Dashboard bot', scopes: ['readiness:review'], actor: 'admin-1' });
  assert.equal((await call('GET', '/readiness', { key: sam.key })).status, 403);
  assert.equal((await call('POST', '/readiness/assessments', { key: sam.key })).status, 403);
  assert.equal((await call('PUT', '/readiness/items/testing.staff_trained', { key: sam.key, body: { status: 'done' } })).status, 403);
  const bySystem = await call('POST', '/readiness/assessments', { key: system.key });
  assert.equal(bySystem.status, 403);
  assert.match(bySystem.body.message, /must be made by a person/);
  assert.equal((await call('GET', '/readiness', { key: null })).status, 401);

  const denied = db.prepare("SELECT after_json FROM audit_entries WHERE entity_type = 'api_access' AND action = 'denied' ORDER BY id").all().map((d) => JSON.parse(d.after_json).operation);
  assert.deepEqual(denied, ['readinessChecklist', 'runReadinessAssessment', 'recordReadinessItem', 'runReadinessAssessment', 'readinessChecklist']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM readiness_assessments').get().n, 0);
});

test('the OpenAPI contract documents readiness with exactly the item keys and fields the code uses', async (t) => {
  const { call, stop } = await start();
  t.after(stop);
  const doc = (await call('GET', '/openapi.json', { key: null })).body;
  const put = doc.paths['/readiness/items/{key}'].put;
  assert.deepEqual(put.parameters[0].schema.enum, Object.keys(MANUAL_ITEMS));
  const { ITEM_FIELDS } = await import('../server/api/readinessRoutes.js');
  assert.deepEqual(Object.keys(put.requestBody.content['application/json'].schema.properties), ITEM_FIELDS);
  assert.ok(doc.paths['/readiness/assessments'].post.responses['503']);
});
