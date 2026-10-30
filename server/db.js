// The one place the work order system talks to its database.
// SQLite (built into Node) for now; moving to Postgres later should only change this file.

import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS work_orders (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    description   TEXT,
    work_type     TEXT NOT NULL,
    priority      TEXT NOT NULL DEFAULT 'normal',
    status        TEXT NOT NULL DEFAULT 'open',
    location_text TEXT,                 -- freeform, for when GIS has no location (REQ-032)
    address       TEXT,                 -- autofilled from the first selected GIS asset
    latitude      REAL,
    longitude     REAL,
    created_by    TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    completed_at  TEXT,
    completion_note TEXT,
    request_id    TEXT UNIQUE           -- caller-supplied; the same create sent twice makes one work order
  );

  -- The GIS assets selected for a work order, with a snapshot of what GIS said at the time.
  CREATE TABLE IF NOT EXISTS work_order_assets (
    work_order_id   TEXT NOT NULL REFERENCES work_orders(id),
    asset_id        TEXT NOT NULL,
    asset_type      TEXT,
    asset_name      TEXT,
    attributes_json TEXT,
    PRIMARY KEY (work_order_id, asset_id)
  );

  -- Every write-back to GIS: queued in the same transaction as the change, then pushed.
  -- A row that is not 'done' can be retried; nothing is lost if GIS is down.
  CREATE TABLE IF NOT EXISTS gis_sync (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    work_order_id TEXT NOT NULL REFERENCES work_orders(id),
    asset_id      TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',   -- pending | done | failed
    attempts      INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT,
    requested_at  TEXT NOT NULL,
    completed_at  TEXT
  );

  -- How far through GIS's change list we have processed. Advanced in the same transaction as
  -- the change it covers, so a crash or lost connection resumes exactly where it stopped.
  CREATE TABLE IF NOT EXISTS gis_cursor (
    name       TEXT PRIMARY KEY,
    value      INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Every call to GIS, one row per attempt (so retries are visible). Append-only.
  CREATE TABLE IF NOT EXISTS gis_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    operation     TEXT NOT NULL,                 -- e.g. getAsset, linkWorkOrder
    asset_id      TEXT,
    attempt       INTEGER NOT NULL,
    outcome       TEXT NOT NULL,                 -- ok | error | timeout | unauthorized
    error         TEXT,
    started_at    TEXT NOT NULL,
    finished_at   TEXT NOT NULL,
    duration_ms   INTEGER NOT NULL
  );

  -- Append-only: rows are inserted, never updated or deleted.
  CREATE TABLE IF NOT EXISTS audit_entries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id   TEXT NOT NULL,
    action      TEXT NOT NULL,
    actor       TEXT NOT NULL,
    before_json TEXT,
    after_json  TEXT,
    occurred_at TEXT NOT NULL
  );
`;

/** Open (or create) a database and make sure the tables exist. Use ':memory:' in tests. */
export function openDatabase(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

/**
 * Run fn inside one transaction: everything it writes is saved together, or nothing is.
 * This is what guarantees a work order never exists without its audit entry.
 */
export function inTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
