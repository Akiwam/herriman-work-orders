// STORY-010 — operational readiness: the checklist, and the items only people can confirm.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../server/db.js';
import { ValidationError, NotFoundError } from '../server/workOrders.js';
import { bootstrapAdministrator, createUser, grantRole, AccessDeniedError, PERMISSIONS } from '../server/access.js';
import { MANUAL_ITEMS, listManualItems, recordItem, READINESS_REVIEW } from '../server/readiness.js';

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
const itemAudits = (db) => db.prepare("SELECT * FROM audit_entries WHERE entity_type = 'readiness_item' ORDER BY id").all();
const UAT = 'testing.user_acceptance';

test('the checklist covers configuration, testing and data conversion (REQ-052), all starting not started', () => {
  const { db } = setup();
  const items = listManualItems(db);
  assert.deepEqual([...new Set(items.map((i) => i.category))], ['configuration', 'testing', 'data_conversion']);
  assert.equal(items.length, Object.keys(MANUAL_ITEMS).length);
  assert.ok(items.every((i) => i.status === 'not_started' && !i.passed && i.version === 0));
  assert.ok(PERMISSIONS.includes(READINESS_REVIEW));
});

test('a project manager records an item; it is versioned and audited with their user id and the time', () => {
  const { db, pat, byPat } = setup();
  const { item, changed } = recordItem(db, UAT, { status: 'in_progress', due_on: '2027-03-31', note: 'UAT sessions booked with Public Works' },
    { ...byPat, now: () => '2026-11-02T15:00:00.000Z' });
  assert.equal(changed, true);
  assert.deepEqual([item.status, item.passed, item.due_on, item.version, item.updated_by], ['in_progress', false, '2027-03-31', 1, pat.id]);

  recordItem(db, UAT, { status: 'done' }, byPat);
  const done = listManualItems(db).find((i) => i.key === UAT);
  assert.deepEqual([done.status, done.passed, done.note, done.due_on], ['done', true, 'UAT sessions booked with Public Works', '2027-03-31'], 'fields left out are kept');

  const [first, second] = itemAudits(db);
  assert.deepEqual([first.entity_id, first.action, first.actor_user_id, first.actor, first.occurred_at],
    [UAT, 'record', pat.id, 'pat.pm@herriman.example', '2026-11-02T15:00:00.000Z']);
  assert.deepEqual(JSON.parse(second.before_json).status, 'in_progress');
  assert.deepEqual(JSON.parse(second.after_json).status, 'done');
});

test('recording the same values twice changes nothing', () => {
  const { db, byPat } = setup();
  recordItem(db, UAT, { status: 'blocked', note: 'Waiting for test accounts' }, byPat);
  assert.equal(recordItem(db, UAT, { status: 'blocked', note: 'Waiting for test accounts' }, byPat).changed, false);
  assert.equal(itemAudits(db).length, 1);
});

test('"not applicable" counts as passed only with a note saying why', () => {
  const { db, byPat } = setup();
  assert.throws(() => recordItem(db, 'testing.staff_trained', { status: 'not_applicable' }, byPat), /a note is required/);
  const { item } = recordItem(db, 'testing.staff_trained', { status: 'not_applicable', note: 'Same staff already use the old system daily' }, byPat);
  assert.equal(item.passed, true);
});

// ---------- failure paths ----------

test('unknown items, statuses, fields or dates are refused, and nothing is saved', () => {
  const { db, byPat } = setup();
  assert.throws(() => recordItem(db, 'testing.vibes', { status: 'done' }, byPat), NotFoundError);
  assert.throws(() => recordItem(db, 'toString', { status: 'done' }, byPat), NotFoundError);
  assert.throws(() => recordItem(db, UAT, { status: 'finished', colour: 'red', due_on: 'next week' }, byPat),
    (err) => err instanceof ValidationError && err.problems.length === 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM readiness_items').get().n, 0);
});

test('if the audit entry cannot be written, the item is not recorded', () => {
  const { db, byPat } = setup();
  assert.throws(() => recordItem(db, UAT, { status: 'done' }, { ...byPat, audit: () => { throw new Error('audit store unavailable'); } }), /audit store unavailable/);
  assert.equal(listManualItems(db).find((i) => i.key === UAT).status, 'not_started');
});

test('only people with readiness:review can record items', () => {
  const { db, admin, sam } = setup();
  assert.throws(() => recordItem(db, UAT, { status: 'done' }, { actorUserId: sam.id }), AccessDeniedError, 'field crew cannot');
  assert.throws(() => recordItem(db, UAT, { status: 'done' }, {}), AccessDeniedError, 'no user, no change');
  assert.equal(recordItem(db, UAT, { status: 'in_progress' }, { actorUserId: admin.id }).changed, true, 'a system administrator can');
});
