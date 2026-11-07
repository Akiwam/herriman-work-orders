// STORY-009 — coordinating each vendor (REQ-054): steps in order, recorded by people, audited.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../server/db.js';
import { ValidationError, NotFoundError } from '../server/workOrders.js';
import { bootstrapAdministrator, issueUserKey, createUser, grantRole, AccessDeniedError } from '../server/access.js';
import { createApiClient } from '../server/api/clients.js';
import { createApiServer } from '../server/api/server.js';
import { STEPS, getCoordination, listCoordination, recordStep } from '../server/vendorCoordination.js';

function setup() {
  const db = openDatabase();
  const admin = bootstrapAdministrator(db, { email: 'jane.admin@herriman.example', display_name: 'Jane Admin' });
  const as = { actorUserId: admin.id };
  const pat = createUser(db, { email: 'pat.pm@herriman.example', display_name: 'Pat Project-Manager' }, as);
  grantRole(db, { userId: pat.id, roleId: 'project_manager' }, as);
  const sam = createUser(db, { email: 'sam@herriman.example', display_name: 'Sam Crew' }, as);
  grantRole(db, { userId: sam.id, roleId: 'field_crew' }, as);
  return { db, admin, pat, sam, byPat: { actorUserId: pat.id } };
}
const done = (note) => ({ done: true, note });

test('every vendor starts with all four steps not done', () => {
  const { db } = setup();
  const all = listCoordination(db);
  assert.deepEqual(all.map((c) => c.vendor), ['madison_ai', 'lama', 'sprypoint']);
  assert.ok(all.every((c) => !c.signed_off && c.steps.map((s) => s.step).join() === STEPS.join() && c.steps.every((s) => !s.done)));
});

test('steps are recorded in order, each audited with the user id and time, until the vendor is signed off', () => {
  const { db, pat, byPat } = setup();
  recordStep(db, 'lama', 'contract_shared', done('Contract v1 emailed to Lama on 2026-11-06'), { ...byPat, now: () => '2026-11-06T15:00:00.000Z' });
  recordStep(db, 'lama', 'fields_confirmed', done('Lama confirmed the fields'), byPat);
  recordStep(db, 'lama', 'sandbox_tested', done('npm run vendor:check passed against the test system'), byPat);
  const { coordination } = recordStep(db, 'lama', 'signed_off', done('Signed off by Public Works and Lama'), byPat);
  assert.equal(coordination.signed_off, true);

  const entries = db.prepare("SELECT * FROM audit_entries WHERE entity_type = 'vendor_coordination' ORDER BY id").all();
  assert.deepEqual(entries.map((e) => e.entity_id), ['lama:contract_shared', 'lama:fields_confirmed', 'lama:sandbox_tested', 'lama:signed_off']);
  assert.ok(entries.every((e) => e.actor_user_id === pat.id));
  assert.equal(entries[0].occurred_at, '2026-11-06T15:00:00.000Z');
  assert.equal(getCoordination(db, 'sprypoint').signed_off, false, 'other vendors are unaffected');
});

test('nothing is signed off untested: a step cannot be done before the ones it depends on', () => {
  const { db, byPat } = setup();
  assert.throws(() => recordStep(db, 'sprypoint', 'signed_off', done('Looks fine'), byPat),
    (err) => err instanceof ValidationError && /cannot be done before contract_shared, fields_confirmed, sandbox_tested/.test(err.problems[0]));
  recordStep(db, 'sprypoint', 'contract_shared', done('Sent'), byPat);
  recordStep(db, 'sprypoint', 'fields_confirmed', done('Confirmed'), byPat);
  assert.throws(() => recordStep(db, 'sprypoint', 'contract_shared', { done: false, note: 'Oops' }, byPat), /cannot be undone while fields_confirmed is done/);
  assert.equal(recordStep(db, 'sprypoint', 'fields_confirmed', { done: false, note: 'SpryPoint asked for one more field' }, byPat).changed, true, 'the latest step can be undone, with a reason');
});

test('the same values again change nothing; a note is always required; bad input is refused', () => {
  const { db, byPat } = setup();
  recordStep(db, 'madison_ai', 'contract_shared', done('Sent'), byPat);
  assert.equal(recordStep(db, 'madison_ai', 'contract_shared', done('Sent'), byPat).changed, false);
  assert.throws(() => recordStep(db, 'madison_ai', 'fields_confirmed', { done: true }, byPat), /a note is required/);
  assert.throws(() => recordStep(db, 'madison_ai', 'party', done('x'), byPat), /step must be one of/);
  assert.throws(() => recordStep(db, 'madison_ai', 'fields_confirmed', { done: 'yes', note: 'x', colour: 1 }, byPat), (err) => err.problems.length === 2);
  assert.throws(() => recordStep(db, 'scada', 'contract_shared', done('x'), byPat), NotFoundError);
});

test('if the audit entry cannot be written, the step is not recorded', () => {
  const { db, byPat } = setup();
  assert.throws(() => recordStep(db, 'lama', 'contract_shared', done('Sent'), { ...byPat, audit: () => { throw new Error('audit store unavailable'); } }), /audit store unavailable/);
  assert.equal(getCoordination(db, 'lama').steps[0].done, false);
});

test('only people with readiness:review can record steps — over HTTP too, and never with a system key', async (t) => {
  const { db, admin, pat, sam } = setup();
  assert.throws(() => recordStep(db, 'lama', 'contract_shared', done('Sent'), { actorUserId: sam.id }), AccessDeniedError);

  const patKey = issueUserKey(db, pat.id, { actorUserId: admin.id }).key;
  const lamaKey = createApiClient(db, { name: 'Lama', scopes: ['vendor_feed:lama', 'readiness:review'], actor: 'admin-1' }).key;
  const server = createApiServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/vendors/lama/coordination`;
  const call = async (method, path, key, body) => {
    const res = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };

  const put = await call('PUT', '/contract_shared', patKey, done('Contract v1 emailed to Lama'));
  assert.deepEqual([put.status, put.body.changed, put.body.item.steps[0].done], [200, true, true]);
  assert.equal((await call('GET', '', patKey)).body.item.steps[0].note, 'Contract v1 emailed to Lama');
  const bySystem = await call('PUT', '/fields_confirmed', lamaKey, done('We confirm ourselves'));
  assert.equal(bySystem.status, 403, 'a vendor cannot sign off its own integration');
  assert.match(bySystem.body.message, /must be made by a person/);
});
