// STORY-008 — system settings: saved with an audit entry, confirmed, never half-saved.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../server/db.js';
import { ValidationError, NotFoundError, writeAudit } from '../server/workOrders.js';
import { bootstrapAdministrator, createUser, grantRole, AccessDeniedError } from '../server/access.js';
import {
  SETTINGS, getSetting, listSettings, setSetting, resetSetting, SettingNotSavedError, SettingVersionConflictError,
} from '../server/settings.js';
import { RATE_LIMIT, IP_RETENTION_DAYS } from '../server/publicRequests.js';
import { REVIEW_OVERDUE_DAYS } from '../server/vendorSubmissions.js';
import { CELL_SIZE } from '../server/heatMaps.js';

function setup() {
  const db = openDatabase();
  const admin = bootstrapAdministrator(db, { email: 'jane.admin@herriman.example', display_name: 'Jane Admin' });
  const sue = createUser(db, { email: 'sue@herriman.example', display_name: 'Sue Supervisor' }, { actorUserId: admin.id });
  grantRole(db, { userId: sue.id, roleId: 'supervisor' }, { actorUserId: admin.id });
  return { db, admin, sue, as: { actorUserId: admin.id } };
}
const settingAudits = (db) => db.prepare("SELECT * FROM audit_entries WHERE entity_type = 'setting' ORDER BY id").all();
const LIMIT = 'public.rate_limit_per_hour';

test('defaults are the values the system used before settings existed', () => {
  assert.equal(SETTINGS['public.rate_limit_per_hour'].default, RATE_LIMIT.max);
  assert.equal(RATE_LIMIT.windowMinutes, 60, 'the setting is per hour');
  assert.equal(SETTINGS['public.ip_retention_days'].default, IP_RETENTION_DAYS);
  assert.equal(SETTINGS['vendor.review_overdue_days'].default, REVIEW_OVERDUE_DAYS);
  assert.equal(SETTINGS['heat_maps.default_cell_size_m'].default, CELL_SIZE.default);
  assert.deepEqual([SETTINGS['heat_maps.default_cell_size_m'].min, SETTINGS['heat_maps.default_cell_size_m'].max], [CELL_SIZE.min, CELL_SIZE.max]);

  const db = openDatabase();
  assert.equal(getSetting(db, LIMIT), 5);
  assert.ok(listSettings(db).every((s) => s.is_default && s.version === 0));
});

test('a setting is saved, read back, versioned and audited with the user id and time', () => {
  const { db, admin, as } = setup();
  const { setting, changed } = setSetting(db, LIMIT, 10, { ...as, now: () => '2026-11-03T10:00:00.000Z' });
  assert.equal(changed, true);
  assert.deepEqual([setting.value, setting.version, setting.is_default, setting.updated_by], [10, 1, false, admin.id]);
  assert.equal(getSetting(db, LIMIT), 10);

  const [entry] = settingAudits(db);
  assert.deepEqual([entry.entity_id, entry.action, entry.actor_user_id, entry.actor, entry.occurred_at],
    [LIMIT, 'set', admin.id, 'jane.admin@herriman.example', '2026-11-03T10:00:00.000Z']);
  assert.deepEqual(JSON.parse(entry.before_json), { value: 5, is_default: true, version: 0 });
  assert.deepEqual(JSON.parse(entry.after_json), { value: 10, is_default: false, version: 1 });
});

test('resetting goes back to the default, and is audited too', () => {
  const { db, as } = setup();
  setSetting(db, LIMIT, 10, as);
  const { setting, changed } = resetSetting(db, LIMIT, as);
  assert.equal(changed, true);
  assert.deepEqual([setting.value, setting.is_default, setting.version], [5, true, 2]);
  assert.deepEqual(settingAudits(db).map((e) => e.action), ['set', 'reset']);
  assert.equal(resetSetting(db, LIMIT, as).changed, false, 'already the default');
});

test('saving the same value twice changes nothing', () => {
  const { db, as } = setup();
  setSetting(db, LIMIT, 10, as);
  const again = setSetting(db, LIMIT, 10, as);
  assert.equal(again.changed, false);
  assert.equal(again.setting.version, 1);
  assert.equal(settingAudits(db).length, 1);
});

// ---------- failure path: configuration not saved ----------

test('invalid values and unknown settings are refused, and nothing is saved', () => {
  const { db, as } = setup();
  for (const [value, expected] of [[0, /between 1 and 100/], [101, /between 1 and 100/], [2.5, /whole number/], ['10', /whole number/]]) {
    assert.throws(() => setSetting(db, LIMIT, value, as), (err) => err instanceof ValidationError && expected.test(err.problems[0]));
  }
  assert.throws(() => setSetting(db, LIMIT, null, as), /reset it/);
  assert.throws(() => setSetting(db, 'public.colour', 'red', as), NotFoundError);
  assert.throws(() => setSetting(db, 'toString', 1, as), NotFoundError, 'only real settings, not object properties');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM system_settings').get().n, 0);
  assert.equal(settingAudits(db).length, 0);
});

test('if the audit entry cannot be written, the setting is not saved', () => {
  const { db, as } = setup();
  assert.throws(() => setSetting(db, LIMIT, 10, { ...as, audit: () => { throw new Error('audit store unavailable'); } }), /audit store unavailable/);
  assert.equal(getSetting(db, LIMIT), 5);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM system_settings').get().n, 0);
});

test('if what was stored does not match what was sent, nothing is kept ("configuration not saved")', () => {
  const { db, as } = setup();
  const tampering = (d, entry) => {
    d.prepare("UPDATE system_settings SET value_json = '99' WHERE key = ?").run(entry.entityId);
    writeAudit(d, entry);
  };
  assert.throws(() => setSetting(db, LIMIT, 10, { ...as, audit: tampering }), SettingNotSavedError);
  assert.equal(getSetting(db, LIMIT), 5);
  assert.equal(settingAudits(db).length, 0);
});

test('a change from an out-of-date copy is refused', () => {
  const { db, as } = setup();
  setSetting(db, LIMIT, 10, { ...as, expectedVersion: 0 });
  assert.throws(() => setSetting(db, LIMIT, 20, { ...as, expectedVersion: 0 }), SettingVersionConflictError);
  assert.equal(getSetting(db, LIMIT), 10);
  assert.equal(setSetting(db, LIMIT, 20, { ...as, expectedVersion: 1 }).setting.version, 2);
});

test('a damaged stored value falls back to the default and is reported, instead of breaking the system', () => {
  const { db } = setup();
  db.prepare("INSERT INTO system_settings (key, value_json, version, updated_by, updated_at) VALUES (?, '{oops', 1, 'x', 'y')").run(LIMIT);
  const seen = [];
  assert.equal(getSetting(db, LIMIT, { onError: (e) => seen.push(e.message) }), 5);
  assert.match(seen[0], /cannot be read/);
  assert.match(listSettings(db).find((s) => s.key === LIMIT).problem, /using the default/);

  db.prepare("UPDATE system_settings SET value_json = '5000' WHERE key = ?").run(LIMIT);
  assert.equal(getSetting(db, LIMIT), 5, 'an out-of-range stored value is not used either');

  const broken = { prepare() { throw new Error('database is locked'); } };
  assert.equal(getSetting(broken, LIMIT), 5);
});

// ---------- failure path: unauthorized access ----------

test('only people with settings:admin can change settings', () => {
  const { db, sue } = setup();
  assert.throws(() => setSetting(db, LIMIT, 50, { actorUserId: sue.id }), AccessDeniedError, 'a supervisor cannot');
  assert.throws(() => resetSetting(db, LIMIT, { actorUserId: sue.id }), AccessDeniedError);
  assert.throws(() => setSetting(db, LIMIT, 50, {}), AccessDeniedError, 'no user, no change');
  assert.equal(getSetting(db, LIMIT), 5);
});

test('a database made before settings gets settings:admin added to the built-in administrator role', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hwo-settings-'));
  const file = join(dir, 'old.db');
  try {
    const old = openDatabase(file);
    old.prepare(`UPDATE roles SET permissions_json = '["access:admin","audit:read"]' WHERE id = 'system_admin'`).run(); // as before this story
    old.close();
    const db = openDatabase(file);
    const perms = JSON.parse(db.prepare("SELECT permissions_json FROM roles WHERE id = 'system_admin'").get().permissions_json);
    assert.ok(perms.includes('settings:admin'));
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
