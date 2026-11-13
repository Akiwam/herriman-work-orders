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
    request_id    TEXT UNIQUE,          -- caller-supplied; the same create sent twice makes one work order
    is_public     INTEGER NOT NULL DEFAULT 0, -- 1 once staff publish it on the public site (STORY-003)
    version       INTEGER NOT NULL DEFAULT 1, -- +1 on every change; lets callers detect a stale update (STORY-004)
    workflow_id   TEXT,                 -- the workflow version it follows; kept even after a newer version is published (STORY-006)
    current_step  TEXT,                 -- its step in that workflow
    step_entered_at TEXT,               -- when it reached that step
    assigned_to   TEXT                  -- user id of the person it is assigned to; NULL = unassigned (STORY-014)
  );

  -- Requests citizens submit on the public site (STORY-003, REQ-037). Each one creates a work order.
  CREATE TABLE IF NOT EXISTS service_requests (
    id            TEXT PRIMARY KEY,
    tracking_code TEXT NOT NULL UNIQUE,       -- given to the citizen to check on their request
    submission_id TEXT NOT NULL UNIQUE,       -- the same submission sent twice makes one request
    description   TEXT NOT NULL,
    category      TEXT NOT NULL,
    location_text TEXT NOT NULL,
    latitude      REAL,
    longitude     REAL,
    contact       TEXT,                       -- optional; never shown publicly or sent to outside systems
    work_order_id TEXT REFERENCES work_orders(id), -- set when a person approves its intake draft (STORY-015); empty until then
    submitted_at  TEXT NOT NULL
  );

  -- Every public submission attempt, accepted or not, with its IP address and time (STORY-003 Trust).
  -- Staff-only: never returned by any public or outside-system endpoint. IPs are personal data and
  -- are kept for a limited time (see purgeSubmissionIps).
  CREATE TABLE IF NOT EXISTS public_submission_log (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    ip_address         TEXT,                  -- NULL once purged after the retention period
    submitted_at       TEXT NOT NULL,
    outcome            TEXT NOT NULL,         -- accepted | duplicate | rejected | rate_limited
    service_request_id TEXT,
    detail             TEXT
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

  -- Utility locate tickets received from the one-call centre (Blue Stakes of Utah) (REQ-039).
  -- Built from the proposed locate_ticket table in knowledge/data-model.json.
  CREATE TABLE IF NOT EXISTS locate_tickets (
    id               TEXT PRIMARY KEY,
    ticket_number    TEXT NOT NULL UNIQUE,       -- the one-call centre's number; importing it twice makes one ticket
    ticket_type      TEXT NOT NULL,              -- normal | emergency
    status           TEXT NOT NULL,              -- received | in_progress | responded | completed
    excavator_name   TEXT NOT NULL,
    work_description TEXT NOT NULL,
    dig_address      TEXT NOT NULL,
    latitude         REAL,
    longitude        REAL,
    received_at      TEXT NOT NULL,
    due_at           TEXT NOT NULL,              -- when the response is due to the one-call centre
    locator_notes    TEXT,
    marking_details  TEXT,
    work_order_id    TEXT REFERENCES work_orders(id),
    response_code    TEXT,
    response_note    TEXT,
    responded_at     TEXT,
    completed_at     TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  );

  -- Responses waiting to be (or already) delivered to the one-call centre. Queued in the same
  -- transaction as the response; response_id makes delivery idempotent on both sides.
  CREATE TABLE IF NOT EXISTS bluestakes_outbox (
    response_id   TEXT PRIMARY KEY,
    ticket_id     TEXT NOT NULL REFERENCES locate_tickets(id),
    response_code TEXT NOT NULL,
    response_note TEXT,
    status        TEXT NOT NULL DEFAULT 'pending',   -- pending | delivered | failed
    attempts      INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT,
    queued_at     TEXT NOT NULL,
    delivered_at  TEXT
  );

  -- Every call to the one-call centre, one row per attempt. Append-only.
  CREATE TABLE IF NOT EXISTS bluestakes_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    operation     TEXT NOT NULL,
    ticket_number TEXT,
    attempt       INTEGER NOT NULL,
    outcome       TEXT NOT NULL,                 -- ok | error | timeout | unauthorized
    error         TEXT,
    started_at    TEXT NOT NULL,
    finished_at   TEXT NOT NULL,
    duration_ms   INTEGER NOT NULL
  );

  -- Workflows (STORY-006, REQ-045): the steps a work order goes through. Versioned: a change is
  -- published as a new version; work orders keep the version they started on. Built from the
  -- proposed workflow / workflow_step tables in knowledge/data-model.json.
  CREATE TABLE IF NOT EXISTS workflows (
    id                TEXT PRIMARY KEY,
    workflow_key      TEXT NOT NULL,            -- e.g. pothole_repair; the same across versions
    version           INTEGER NOT NULL,
    name              TEXT NOT NULL,
    work_type         TEXT,                     -- the work type it is for; NULL only for the built-in Standard workflow
    status            TEXT NOT NULL,            -- active | superseded | retired
    definition_sha256 TEXT NOT NULL,            -- fingerprint of the steps, to confirm it was saved as sent
    created_by        TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    UNIQUE (workflow_key, version)
  );

  CREATE TABLE IF NOT EXISTS workflow_steps (
    workflow_id     TEXT NOT NULL REFERENCES workflows(id),
    step_key        TEXT NOT NULL,
    position        INTEGER NOT NULL,           -- 1 = the step a work order starts on
    name            TEXT NOT NULL,
    is_final        INTEGER NOT NULL,           -- 1 = reaching it completes the work order
    next_steps_json TEXT NOT NULL,              -- JSON array of the step keys it may move to
    required_role   TEXT,                       -- reserved for STORY-007 (role-based access); not enforced yet
    PRIMARY KEY (workflow_id, step_key)
  );

  -- The built-in Standard workflow is today's behaviour: open, then completed. It applies to every
  -- work type without a workflow of its own, so existing work keeps working exactly as before.
  INSERT OR IGNORE INTO workflows (id, workflow_key, version, name, work_type, status, definition_sha256, created_by, created_at)
    VALUES ('wf-standard-1', 'standard', 1, 'Standard', NULL, 'active', 'built-in', 'system', '2026-10-01T00:00:00.000Z');
  INSERT OR IGNORE INTO workflow_steps (workflow_id, step_key, position, name, is_final, next_steps_json)
    VALUES ('wf-standard-1', 'open', 1, 'Open', 0, '["completed"]'),
           ('wf-standard-1', 'completed', 2, 'Completed', 1, '[]');

  -- People who use the system, and what they may do (STORY-007, REQ-047). Built from the proposed
  -- app_user / role / user_role tables in knowledge/data-model.json. Outside systems (Madison AI,
  -- Blue Stakes, vendors) stay in api_clients; these are staff.
  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    email        TEXT NOT NULL UNIQUE,      -- stored lower-case
    display_name TEXT NOT NULL,
    is_active    INTEGER NOT NULL DEFAULT 1,
    key_prefix   TEXT UNIQUE,               -- the user's personal API key: prefix in clear, the rest only as a hash
    key_hash     TEXT,
    created_by   TEXT NOT NULL,             -- user id of the administrator, or 'system' for the first one
    created_at   TEXT NOT NULL,
    version      INTEGER NOT NULL DEFAULT 1 -- +1 on every change to the user (STORY-008)
  );

  -- A role is a named set of permissions. The permissions are the same names API client scopes use.
  CREATE TABLE IF NOT EXISTS roles (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL UNIQUE,
    description      TEXT NOT NULL,
    permissions_json TEXT NOT NULL,         -- JSON array, e.g. ["work_orders:read"]
    is_builtin       INTEGER NOT NULL DEFAULT 0
  );

  -- System settings administrators can change (STORY-008, REQ-047). Which settings exist, their
  -- types, ranges and defaults are defined in code (server/settings.js); this holds only the values
  -- the city has chosen. value_json NULL means "back to the default". Never holds secrets.
  CREATE TABLE IF NOT EXISTS system_settings (
    key        TEXT PRIMARY KEY,
    value_json TEXT,
    version    INTEGER NOT NULL,             -- +1 on every change; lets two administrators not overwrite each other
    updated_by TEXT NOT NULL,                -- user id
    updated_at TEXT NOT NULL
  );

  -- Operational readiness (STORY-010, REQ-052, REQ-053). Which checklist items exist is defined in
  -- code (server/readiness.js); this holds the current state of the items people record by hand.
  CREATE TABLE IF NOT EXISTS readiness_items (
    item_key   TEXT PRIMARY KEY,
    status     TEXT NOT NULL,                -- not_started | in_progress | blocked | done | not_applicable
    note       TEXT,                         -- evidence or reason; required for not_applicable
    due_on     TEXT,                         -- YYYY-MM-DD; time allotted for this task (REQ-052)
    version    INTEGER NOT NULL,
    updated_by TEXT NOT NULL,                -- user id
    updated_at TEXT NOT NULL
  );

  -- One row per readiness assessment: a permanent record of who assessed, when, every item's result
  -- and the verdict. Never updated or deleted.
  CREATE TABLE IF NOT EXISTS readiness_assessments (
    id               TEXT PRIMARY KEY,
    request_id       TEXT UNIQUE,            -- the same request sent twice returns the first assessment
    reviewer_user_id TEXT NOT NULL,
    reviewer_email   TEXT NOT NULL,
    started_at       TEXT NOT NULL,
    finished_at      TEXT NOT NULL,
    target_date      TEXT NOT NULL,          -- the go-live date assessed against (REQ-053)
    days_remaining   INTEGER NOT NULL,
    verdict          TEXT NOT NULL,          -- ready | not_ready
    summary_json     TEXT NOT NULL,          -- counts of passed / failed / errors
    results_json     TEXT NOT NULL           -- every item: key, kind, status, passed, detail
  );

  -- Every request a vendor makes to its feed (STORY-009, REQ-054/055): accepted, refused, invalid or
  -- failed. One row per request, written whatever the outcome; if it cannot be written, no data is sent.
  CREATE TABLE IF NOT EXISTS vendor_exchange_log (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id       TEXT,                    -- the X-Request-Id, linking to api_request_log
    vendor           TEXT NOT NULL,           -- the vendor key asked for, e.g. lama
    client_name      TEXT NOT NULL,           -- who asked: the API client, 'anonymous' or 'invalid key'
    contract_version INTEGER,
    params_json      TEXT,                    -- since, limit, cursor as received
    records_returned INTEGER NOT NULL DEFAULT 0,
    outcome          TEXT NOT NULL,           -- ok | denied | invalid | mismatch | error
    error            TEXT,
    started_at       TEXT NOT NULL,
    finished_at      TEXT NOT NULL,
    duration_ms      INTEGER NOT NULL
  );

  -- Coordination with each integration vendor (STORY-009, REQ-054): contract shared, fields confirmed,
  -- sandbox tested, signed off. Recorded by people; every change is audited.
  CREATE TABLE IF NOT EXISTS vendor_coordination (
    vendor     TEXT NOT NULL,
    step       TEXT NOT NULL,
    done       INTEGER NOT NULL,
    note       TEXT NOT NULL,
    version    INTEGER NOT NULL,
    updated_by TEXT NOT NULL,              -- user id
    updated_at TEXT NOT NULL,
    PRIMARY KEY (vendor, step)
  );

  -- Signed-in console sessions (STORY-014). A person signs in with their personal key and gets a
  -- short-lived session token; only its hash is stored. Ends after 30 minutes idle or 8 hours in all.
  CREATE TABLE IF NOT EXISTS console_sessions (
    id           TEXT PRIMARY KEY,
    token_prefix TEXT NOT NULL UNIQUE,
    token_hash   TEXT NOT NULL,
    user_id      TEXT NOT NULL REFERENCES users(id),
    created_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at   TEXT NOT NULL,           -- the absolute end, 8 hours after sign-in
    ended_at     TEXT                     -- set on sign-out
  );

  -- AI-first intake (STORY-015): the agent drafts a work order from a citizen request or a Blue Stakes
  -- ticket; a named person approves, corrects or rejects it. proposed_json is the agent's proposal and
  -- is never changed; final_json is the reviewer's version, which is what becomes the work order.
  CREATE TABLE IF NOT EXISTS intake_drafts (
    id                 TEXT PRIMARY KEY,
    source_type        TEXT NOT NULL,          -- citizen_request | locate_ticket
    source_id          TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL,          -- sha256 of the source as drafted; approval checks it has not changed
    status             TEXT NOT NULL,          -- proposed | approved | rejected | superseded
    version            INTEGER NOT NULL,       -- +1 on every change; two reviewers cannot both act on one version
    proposed_json      TEXT NOT NULL,          -- the agent's fields, as proposed
    undetermined_json  TEXT NOT NULL,          -- fields the agent could not work out, with reasons
    drafted_by         TEXT NOT NULL,          -- which agent, e.g. the rule-based stand-in
    drafted_at         TEXT NOT NULL,
    performer          TEXT NOT NULL,          -- who performs the work (a role, e.g. field_crew)
    approver           TEXT NOT NULL,          -- who must approve it (a role, e.g. supervisor)
    final_json         TEXT,                   -- the reviewer's version (approved), or null
    reviewed_by        TEXT,                   -- user id of the person who approved or rejected
    reviewed_at        TEXT,
    review_note        TEXT,                   -- why it was rejected
    work_order_id      TEXT REFERENCES work_orders(id)
  );
  CREATE INDEX IF NOT EXISTS intake_drafts_source ON intake_drafts (source_type, source_id);

  CREATE TABLE IF NOT EXISTS user_roles (
    user_id    TEXT NOT NULL REFERENCES users(id),
    role_id    TEXT NOT NULL REFERENCES roles(id),
    granted_by TEXT NOT NULL,               -- user id
    granted_at TEXT NOT NULL,
    PRIMARY KEY (user_id, role_id)
  );

  -- A vendor's compliance answer and technical approach for one requirement (STORY-012, REQ-022).
  -- Each resubmission is a new revision; earlier revisions are kept. Built from the proposed
  -- compliance_response table in knowledge/data-model.json.
  CREATE TABLE IF NOT EXISTS vendor_submissions (
    id                 TEXT PRIMARY KEY,
    vendor_id          TEXT NOT NULL,             -- the vendor's API client id
    vendor_name        TEXT NOT NULL,
    requirement_id     TEXT NOT NULL,             -- e.g. REQ-023, from server/vendor/requirements.json
    revision           INTEGER NOT NULL,          -- 1, 2, … per vendor and requirement
    compliance         TEXT NOT NULL,             -- complies | partially_complies | does_not_comply
    technical_approach TEXT NOT NULL,
    content_sha256     TEXT NOT NULL,             -- fingerprint of what was submitted
    submission_key     TEXT,                      -- vendor-supplied; the same key twice stores one submission
    status             TEXT NOT NULL,             -- submitted | approved | changes_requested
    submitted_at       TEXT NOT NULL,
    reviewed_by        TEXT,
    reviewed_at        TEXT,
    review_comment     TEXT,
    UNIQUE (vendor_id, requirement_id, revision),
    UNIQUE (vendor_id, submission_key)
  );

  -- Documents attached to a vendor submission (PDF, Word .docx or plain text, at most 5 MB each).
  -- Saved in the same transaction as the submission, with a fingerprint of the exact bytes.
  CREATE TABLE IF NOT EXISTS vendor_documents (
    id            TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL REFERENCES vendor_submissions(id),
    filename      TEXT NOT NULL,
    content_type  TEXT NOT NULL,
    size_bytes    INTEGER NOT NULL,
    sha256        TEXT NOT NULL,
    content       BLOB NOT NULL,
    uploaded_at   TEXT NOT NULL
  );

  -- Outside systems allowed to read work order data through the API (e.g. Madison AI).
  -- Only a hash of each key is stored; the key itself is shown once, when the client is created.
  CREATE TABLE IF NOT EXISTS api_clients (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    key_prefix  TEXT NOT NULL UNIQUE,          -- the non-secret start of the key, used to look it up
    key_hash    TEXT NOT NULL,                 -- sha256 of the full key
    scopes      TEXT NOT NULL,                 -- JSON array, e.g. ["work_orders:read"]
    created_by  TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    revoked_at  TEXT
  );

  -- Every HTTP request the API receives, whatever the endpoint or outcome (STORY-004 Trust).
  -- Never holds an API key or the values in a request body — only the body's field names and size.
  CREATE TABLE IF NOT EXISTS api_request_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id   TEXT NOT NULL UNIQUE,          -- also sent back as the X-Request-Id header
    received_at  TEXT NOT NULL,
    finished_at  TEXT NOT NULL,
    duration_ms  INTEGER NOT NULL,
    method       TEXT NOT NULL,
    path         TEXT NOT NULL,
    query_json   TEXT,
    client_name  TEXT NOT NULL,                 -- the API client, 'anonymous' (no key) or 'invalid key'
    client_ip    TEXT,
    status       INTEGER,                       -- NULL if the connection closed before a response
    error_code   TEXT,                          -- e.g. invalid_request, unauthorized, conflict
    body_fields  TEXT,                          -- JSON array of the body's top-level field names
    body_bytes   INTEGER
  );

  -- Every heat map generation attempt, successful or not, with its parameters (STORY-005 Trust).
  CREATE TABLE IF NOT EXISTS heat_map_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    requested_by   TEXT NOT NULL,
    format         TEXT,
    params_json    TEXT NOT NULL,             -- the parameters as received (and normalised, when valid)
    started_at     TEXT NOT NULL,
    finished_at    TEXT NOT NULL,
    duration_ms    INTEGER NOT NULL,
    outcome        TEXT NOT NULL,             -- ok | invalid | failed
    error          TEXT,
    total_matching INTEGER,
    mapped         INTEGER,
    unmapped       INTEGER,
    cell_count     INTEGER
  );

  -- "Check now" calls a person makes from the integrations view (STORY-018), one row per check.
  -- A check is a real call through the same client as everything else (so it is also in gis_log);
  -- this row adds what the check found about the reply, e.g. a success with an unexpected shape.
  -- Append-only. The integrations view works out every status from these rows and the call logs;
  -- there is no stored status anywhere.
  CREATE TABLE IF NOT EXISTS integration_checks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    integration   TEXT NOT NULL,               -- e.g. gis
    requested_by  TEXT NOT NULL,               -- the user id of the person who asked for the check
    outcome       TEXT NOT NULL,               -- ok | unexpected_payload | error | timeout | unauthorized
    error         TEXT,
    started_at    TEXT NOT NULL,
    finished_at   TEXT NOT NULL,
    duration_ms   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS integration_checks_by_name ON integration_checks (integration, finished_at);

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
  addWorkflowColumns(db);
  addAuditUserColumn(db);
  addUserVersionColumn(db);
  addAssigneeColumn(db);
  makeRequestWorkOrderOptional(db);
  seedRoles(db);
  return db;
}

/**
 * Databases made before workflows (STORY-006) lack the workflow columns: add them, and put every
 * existing work order on the built-in Standard workflow — open ones on Open, completed ones on
 * Completed — which is exactly how they behaved before. Not a user change, so version is not bumped.
 */
/** Users made before user management (STORY-008) get a version, starting at 1. */
/**
 * Before AI-first intake (STORY-015) every citizen request created a work order at once, so the link
 * was required. Now a request waits for a person to approve its draft, so the link starts empty.
 * SQLite cannot relax NOT NULL in place, so an older database's table is rebuilt once, in a single
 * transaction, keeping every row exactly as it was.
 */
function makeRequestWorkOrderOptional(db) {
  const column = db.prepare('PRAGMA table_info(service_requests)').all().find((c) => c.name === 'work_order_id');
  if (!column || column.notnull === 0) return;
  const columns = 'id, tracking_code, submission_id, description, category, location_text, latitude, longitude, contact, work_order_id, submitted_at';
  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    db.exec(`BEGIN;
      CREATE TABLE service_requests_rebuilt (
        id TEXT PRIMARY KEY, tracking_code TEXT NOT NULL UNIQUE, submission_id TEXT NOT NULL UNIQUE, description TEXT NOT NULL,
        category TEXT NOT NULL, location_text TEXT NOT NULL, latitude REAL, longitude REAL, contact TEXT,
        work_order_id TEXT REFERENCES work_orders(id), submitted_at TEXT NOT NULL);
      INSERT INTO service_requests_rebuilt (${columns}) SELECT ${columns} FROM service_requests;
      DROP TABLE service_requests;
      ALTER TABLE service_requests_rebuilt RENAME TO service_requests;
      COMMIT;`);
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
}

/** Work orders made before the console (STORY-014) get an empty assignee: "Unassigned". */
function addAssigneeColumn(db) {
  const have = db.prepare('PRAGMA table_info(work_orders)').all().some((c) => c.name === 'assigned_to');
  if (!have) db.exec('ALTER TABLE work_orders ADD COLUMN assigned_to TEXT');
}

function addUserVersionColumn(db) {
  const have = db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'version');
  if (!have) db.exec('ALTER TABLE users ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
}

/**
 * Audit entries record the verified user id of whoever acted (STORY-007), next to the actor text.
 * NULL for entries written by outside systems and for entries made before users existed.
 */
function addAuditUserColumn(db) {
  const have = db.prepare('PRAGMA table_info(audit_entries)').all().some((c) => c.name === 'actor_user_id');
  if (!have) db.exec('ALTER TABLE audit_entries ADD COLUMN actor_user_id TEXT');
}

// The built-in roles. PLACEHOLDER names and permissions until the city confirms its real roles;
// administrators will be able to add their own. vendor:submit is deliberately in no staff role —
// it belongs to outside vendors only.
export const BUILTIN_ROLES = [
  ['system_admin', 'System administrator', 'Everything, including who has access and the audit trail.',
    ['work_orders:read', 'work_orders:write', 'workflows:admin', 'heatmaps:read', 'locate_tickets:write', 'vendor:review', 'access:admin', 'audit:read', 'settings:admin', 'readiness:review', 'intake:approve']],
  ['supervisor', 'Supervisor', 'Runs the work: work orders, workflows, locate tickets and heat maps.',
    ['work_orders:read', 'work_orders:write', 'workflows:admin', 'heatmaps:read', 'locate_tickets:write', 'intake:approve']],
  ['field_crew', 'Field crew', 'Reads work orders and moves them along; answers locate tickets.',
    ['work_orders:read', 'work_orders:write', 'locate_tickets:write']],
  ['clerk', 'Clerk', 'Creates and updates work orders.', ['work_orders:read', 'work_orders:write']],
  ['planner', 'Planner', 'Heat maps and reading work orders.', ['work_orders:read', 'heatmaps:read']],
  ['auditor', 'Auditor', 'Read-only, including the audit trail.', ['work_orders:read', 'heatmaps:read', 'audit:read']],
  ['project_manager', 'Project manager', 'Assesses operational readiness for launch; reads work orders, heat maps and the audit trail.',
    ['work_orders:read', 'heatmaps:read', 'audit:read', 'readiness:review']],
];

/**
 * Built-in roles always match the list above, so a database made earlier picks up a new permission
 * (e.g. settings:admin). Built-in roles cannot be edited by administrators, so nothing is lost.
 */
function seedRoles(db) {
  const upsert = db.prepare(`INSERT INTO roles (id, name, description, permissions_json, is_builtin) VALUES (?, ?, ?, ?, 1)
                             ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description,
                             permissions_json = excluded.permissions_json WHERE roles.is_builtin = 1`);
  for (const [id, name, description, permissions] of BUILTIN_ROLES) upsert.run(id, name, description, JSON.stringify(permissions));
}

function addWorkflowColumns(db) {
  const have = new Set(db.prepare('PRAGMA table_info(work_orders)').all().map((c) => c.name));
  for (const col of ['workflow_id', 'current_step', 'step_entered_at']) {
    if (!have.has(col)) db.exec(`ALTER TABLE work_orders ADD COLUMN ${col} TEXT`);
  }
  db.exec(`UPDATE work_orders SET workflow_id = 'wf-standard-1',
             current_step = CASE status WHEN 'completed' THEN 'completed' ELSE 'open' END,
             step_entered_at = COALESCE(completed_at, created_at)
           WHERE workflow_id IS NULL`);
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
