// System settings (STORY-008, REQ-047): values the city decides, changed by administrators without a
// code change.
//
// Which settings exist is fixed here, in code: each has a type, an allowed range, a default and a
// description. The database holds only the values the city has chosen. Every read goes to the
// database (nothing is cached), so a change applies across the system on the very next request.
//
// Settings are shown through the API and recorded in the audit trail, so they must never hold
// secrets (passwords, API keys). There is deliberately no "secret" setting type.

import { inTransaction } from './db.js';
import { writeAudit, ValidationError, ConflictError, NotFoundError } from './workOrders.js';
import { hasPermission, AccessDeniedError } from './access.js';

export const SETTINGS_ADMIN = 'settings:admin';
const defaultNow = () => new Date().toISOString();

/**
 * Every setting. Defaults are the values the code used before settings existed, so nothing changes
 * until an administrator changes it (a test checks they still match).
 */
export const SETTINGS = {
  'public.rate_limit_per_hour': {
    type: 'integer', min: 1, max: 100, default: 5,
    description: 'How many requests one address may submit on the public site per hour.',
  },
  'public.ip_retention_days': {
    type: 'integer', min: 1, max: 3650, default: 90,
    description: 'Days a public submitter\'s IP address is kept, staff-only, before it is removed. PLACEHOLDER until the city\'s records retention rule is known.',
  },
  'vendor.review_overdue_days': {
    type: 'integer', min: 1, max: 60, default: 5,
    description: 'Days a vendor submission may wait for review before it is flagged overdue. PLACEHOLDER until the city sets a rule.',
  },
  'heat_maps.default_cell_size_m': {
    type: 'integer', min: 50, max: 2000, default: 250,
    description: 'Cell size, in metres, of a heat map when the request does not give one.',
  },
};

/** What was stored is not what was sent. Nothing was changed. */
export class SettingNotSavedError extends Error {
  constructor(key) {
    super(`The setting ${key} could not be confirmed as saved. Nothing was changed; please try again.`);
    this.name = 'SettingNotSavedError';
  }
}

/** The caller's copy of the setting is out of date: someone else changed it. Nothing was changed. */
export class SettingVersionConflictError extends ConflictError {
  constructor(key, expectedVersion, currentVersion) {
    super(`The setting ${key} has changed since you read it (you had version ${expectedVersion}, it is now version ${currentVersion}). Read it again and retry.`);
    this.name = 'SettingVersionConflictError';
    this.currentVersion = currentVersion;
  }
}

function definition(key) {
  const def = Object.hasOwn(SETTINGS, key) ? SETTINGS[key] : null;
  if (!def) {
    const err = new NotFoundError(key);
    err.message = `No setting ${key}. Settings: ${Object.keys(SETTINGS).join(', ')}`;
    throw err;
  }
  return def;
}

/** Problems with a value for this setting; empty when it is acceptable. */
export function validateSetting(key, value) {
  const def = definition(key);
  if (def.type === 'integer') {
    if (!Number.isInteger(value)) return [`${key} must be a whole number`];
    if (value < def.min || value > def.max) return [`${key} must be between ${def.min} and ${def.max}`];
  }
  return [];
}

const rowOf = (db, key) => db.prepare('SELECT * FROM system_settings WHERE key = ?').get(key);

/** The stored value, or the default when there is none — or when the stored one is unreadable or out of range. */
function effective(def, key, row) {
  if (!row || row.value_json === null) return { value: def.default, problem: null };
  try {
    const value = JSON.parse(row.value_json);
    const problems = validateSetting(key, value);
    if (problems.length) return { value: def.default, problem: `stored value is not valid (${problems[0]}); using the default` };
    return { value, problem: null };
  } catch {
    return { value: def.default, problem: 'stored value cannot be read; using the default' };
  }
}

/**
 * The value to use now. Never throws for a bad stored value: it falls back to the default (a safe,
 * known value) and tells onError, so a damaged setting cannot stop the system working.
 */
export function getSetting(db, key, { onError = () => {} } = {}) {
  const def = definition(key);
  let row;
  try {
    row = rowOf(db, key);
  } catch (err) {
    onError(err);
    return def.default;
  }
  const { value, problem } = effective(def, key, row);
  if (problem) onError(new Error(`${key}: ${problem}`));
  return value;
}

/** Every setting with its current value, default, version and who last changed it. */
export function listSettings(db) {
  return Object.entries(SETTINGS).map(([key, def]) => {
    const row = rowOf(db, key);
    const { value, problem } = effective(def, key, row);
    return {
      key, value, default: def.default, is_default: !row || row.value_json === null, type: def.type, min: def.min, max: def.max,
      description: def.description, version: row?.version ?? 0, updated_by: row?.updated_by ?? null, updated_at: row?.updated_at ?? null, problem,
    };
  });
}

export const getSettingDetail = (db, key) => (definition(key), listSettings(db).find((s) => s.key === key));

/**
 * Change one setting, or reset it to its default (value: null / resetSetting).
 *
 * - Needs settings:admin. Out of range or unknown: refused, nothing saved.
 * - expectedVersion (optional): refused if someone else changed it since it was read.
 * - The same value again: nothing changes (changed: false), no audit entry.
 * - Otherwise saved with its audit entry (user id, time, before and after) and read back inside the
 *   same transaction; if what was stored differs from what was sent, everything is rolled back.
 *
 * `audit` is only replaceable so tests can prove the rollback.
 */
function changeSetting(db, key, value, { actorUserId, expectedVersion, now = defaultNow, audit = writeAudit } = {}) {
  if (!hasPermission(db, actorUserId, SETTINGS_ADMIN)) throw new AccessDeniedError(SETTINGS_ADMIN);
  const def = definition(key);
  const reset = value === null;
  if (!reset) {
    const problems = validateSetting(key, value);
    if (problems.length) throw new ValidationError(problems);
  }
  if (expectedVersion !== undefined && !(Number.isInteger(expectedVersion) && expectedVersion >= 0)) {
    throw new ValidationError(['expected version must be a whole number of 0 or more']);
  }

  return inTransaction(db, () => {
    const row = rowOf(db, key);
    const version = row?.version ?? 0;
    if (expectedVersion !== undefined && version !== expectedVersion) throw new SettingVersionConflictError(key, expectedVersion, version);

    const storedJson = row?.value_json ?? null;
    const newJson = reset ? null : JSON.stringify(value);
    if (storedJson === newJson) return { setting: getSettingDetail(db, key), changed: false };

    const at = now();
    const actor = db.prepare('SELECT email FROM users WHERE id = ?').get(actorUserId);
    db.prepare(`INSERT INTO system_settings (key, value_json, version, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, version = excluded.version,
                updated_by = excluded.updated_by, updated_at = excluded.updated_at`).run(key, newJson, version + 1, actorUserId, at);
    audit(db, {
      entityType: 'setting', entityId: key, action: reset ? 'reset' : 'set', actor: actor.email, actorUserId,
      before: { value: effective(def, key, row).value, is_default: storedJson === null, version },
      after: { value: reset ? def.default : value, is_default: reset, version: version + 1 }, at,
    });

    // Read it back: if what was stored is not exactly what was sent, roll everything back.
    if ((rowOf(db, key)?.value_json ?? null) !== newJson) throw new SettingNotSavedError(key);
    return { setting: getSettingDetail(db, key), changed: true };
  });
}

export const setSetting = (db, key, value, opts) => {
  if (value === null || value === undefined) throw new ValidationError([`a value is required for ${key}; to go back to the default, reset it`]);
  return changeSetting(db, key, value, opts);
};

export const resetSetting = (db, key, opts) => changeSetting(db, key, null, opts);
