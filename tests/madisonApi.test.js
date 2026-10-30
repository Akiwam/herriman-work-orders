// STORY-011 — open, audited API access for Madison AI.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../server/db.js';
import { ConflictError, ValidationError, NotFoundError, createWorkOrder, updateWorkOrder } from '../server/workOrders.js';
import {
  listWorkOrders, workOrderChanges, searchWorkOrders, getPublicWorkOrder, validateResponse, validateWorkOrder, SCHEMA_VERSION,
} from '../server/api/workOrderFeed.js';
import {
  createApiClient, revokeApiClient, authenticate, auditedRead, UnauthorizedError, AuditUnavailableError,
} from '../server/api/clients.js';

const accessAudits = (db) => db.prepare("SELECT * FROM audit_entries WHERE entity_type = 'api_access' ORDER BY id").all();

function setup() {
  const db = openDatabase();
  const { client, key } = createApiClient(db, { name: 'Madison AI', actor: 'admin-1' });
  return { db, client, key };
}

// ---------- API keys ----------

test('creating an API client returns its key once and stores only a hash', () => {
  const { db, client, key } = setup();
  assert.match(key, /^hwo_[0-9a-f]{8}_[A-Za-z0-9_-]{32}$/);
  assert.deepEqual(client.scopes, ['work_orders:read']);
  const stored = JSON.stringify(db.prepare('SELECT * FROM api_clients').all());
  assert.doesNotMatch(stored, new RegExp(key.split('_')[2]), 'the secret part of the key is not stored');
  const audit = JSON.stringify(db.prepare("SELECT * FROM audit_entries WHERE entity_type = 'api_client'").all());
  assert.doesNotMatch(audit, new RegExp(key.split('_')[2]));
  assert.doesNotMatch(audit, /key_hash/);
});

test('the same client name cannot be registered twice', () => {
  const { db } = setup();
  assert.throws(() => createApiClient(db, { name: 'Madison AI', actor: 'admin-1' }), ConflictError);
});

test('only the exact, unrevoked key authenticates', () => {
  const { db, client, key } = setup();
  assert.equal(authenticate(db, key).id, client.id);
  assert.equal(authenticate(db, `${key}x`), null);
  assert.equal(authenticate(db, 'hwo_00000000_nope'), null);
  assert.equal(authenticate(db, ''), null);
  assert.equal(authenticate(db, undefined), null);
  revokeApiClient(db, client.id, { actor: 'admin-1' });
  assert.equal(authenticate(db, key), null, 'a revoked key stops working');
});

// ---------- every access is audited ----------

test('an allowed read returns the data and is audited with client, operation and record count', () => {
  const { db, key } = setup();
  const result = auditedRead(db, { key, operation: 'listWorkOrders', params: { limit: 2 } }, () => ({ items: [{ id: 'a' }, { id: 'b' }] }));
  assert.equal(result.items.length, 2);

  const [entry] = accessAudits(db);
  assert.equal(entry.action, 'read');
  assert.equal(entry.actor, 'Madison AI');
  const detail = JSON.parse(entry.after_json);
  assert.equal(detail.operation, 'listWorkOrders');
  assert.equal(detail.records_returned, 2);
  assert.deepEqual(detail.params, { limit: 2 });
});

test('a missing or wrong key is refused, the refusal is audited, and the key is not recorded', () => {
  const { db } = setup();
  let readRan = false;
  for (const bad of [undefined, 'hwo_deadbeef_wrongwrongwrong']) {
    assert.throws(() => auditedRead(db, { key: bad, operation: 'listWorkOrders' }, () => { readRan = true; }), UnauthorizedError);
  }
  assert.equal(readRan, false, 'no data is read for an unauthorized request');
  const entries = accessAudits(db);
  assert.deepEqual(entries.map((e) => [e.action, e.actor]), [['denied', 'anonymous'], ['denied', 'anonymous']]);
  assert.doesNotMatch(JSON.stringify(entries), /wrongwrongwrong/);
});

test('a key without the needed scope is refused and audited under its client', () => {
  const db = openDatabase();
  const { key } = createApiClient(db, { name: 'Other system', scopes: [], actor: 'admin-1' });
  assert.throws(() => auditedRead(db, { key, operation: 'listWorkOrders' }, () => ({ items: [] })), UnauthorizedError);
  const [entry] = accessAudits(db);
  assert.equal(entry.actor, 'Other system');
  assert.match(JSON.parse(entry.after_json).reason, /missing scope/);
});

test('if the audit entry cannot be written, the access is refused and no data is returned', () => {
  const { db, key } = setup();
  const failingAudit = () => { throw new Error('audit store unavailable'); };
  let returned;
  assert.throws(() => {
    returned = auditedRead(db, { key, operation: 'listWorkOrders' }, () => ({ items: [{ id: 'secret-ish' }] }), { audit: failingAudit });
  }, AuditUnavailableError);
  assert.equal(returned, undefined);
});

// ---------- the feed and its data format ----------

/** Five work orders created one minute apart, so ordering and "since" are exact. */
async function seeded() {
  const db = openDatabase();
  let minute = 0;
  const at = () => new Date(Date.UTC(2026, 9, 30, 9, minute)).toISOString();
  const make = async (title, extra = {}) => {
    minute += 1;
    return createWorkOrder(db, { title, work_type: 'pothole', location_text: 'Example Way', created_by: 'user-1', request_id: `r-${minute}`, ...extra }, { now: at });
  };
  const ids = [];
  ids.push((await make('Pothole on Example Way')).id);
  ids.push((await make('Broken streetlight', { work_type: 'streetlight', description: 'Lamp flickering at night' })).id);
  ids.push((await make('Graffiti on fence', { work_type: 'graffiti', location_text: 'Behind the rec centre' })).id);
  ids.push((await make('Hydrant leaking', { work_type: 'hydrant' })).id);
  ids.push((await make('100% blocked drain_inlet', { work_type: 'storm_drain' })).id);
  return { db, ids, at, tick: () => { minute += 1; } };
}

test('AC2: every read returns the published format, version 1, and nothing else', async () => {
  const { db, ids } = await seeded();
  const responses = [
    listWorkOrders(db, { limit: 2 }),
    workOrderChanges(db, { since: '2026-10-30T00:00:00Z' }),
    searchWorkOrders(db, { q: 'streetlight' }),
    getPublicWorkOrder(db, { id: ids[0] }),
  ];
  for (const r of responses) {
    assert.equal(r.schema_version, SCHEMA_VERSION);
    assert.deepEqual(validateResponse(r), []);
  }
  const item = getPublicWorkOrder(db, { id: ids[1] }).item;
  assert.deepEqual(Object.keys(item.location), ['text', 'address', 'latitude', 'longitude']);
  assert.equal(item.description, 'Lamp flickering at night');
});

test('internal fields and the audit trail never appear in the feed', async () => {
  const { db } = await seeded();
  const everything = JSON.stringify(listWorkOrders(db, { limit: 200 }));
  for (const internal of ['request_id', '"r-1"', 'gis_sync', 'audit', 'before_json', 'key_hash']) {
    assert.doesNotMatch(everything, new RegExp(internal));
  }
});

test('the format checker catches a wrong data format', () => {
  const good = {
    id: 'x', title: 't', description: null, work_type: 'w', priority: 'normal', status: 'open',
    location: { text: null, address: null, latitude: null, longitude: null }, assets: [],
    created_by: 'u', created_at: '2026-10-30T09:00:00.000Z', updated_at: '2026-10-30T09:00:00.000Z',
    completed_at: null, completion_note: null,
  };
  assert.deepEqual(validateWorkOrder(good), []);
  assert.ok(validateWorkOrder({ ...good, title: 42 }).includes('item.title must be string'));
  assert.ok(validateWorkOrder({ ...good, request_id: 'r' }).includes('item.request_id is not part of the published format'));
  const { status: _s, ...missing } = good;
  assert.ok(validateWorkOrder(missing).includes('item.status is missing'));
  assert.ok(validateWorkOrder({ ...good, updated_at: 'yesterday' }).includes('item.updated_at must be an ISO date-time'));
  assert.ok(validateResponse({ schema_version: 2, items: [] }).includes('schema_version must be 1'));
});

test('AC1 (indexing): paging through the list returns every work order exactly once, in order', async () => {
  const { db, ids } = await seeded();
  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const p = listWorkOrders(db, { limit: 2, cursor });
    seen.push(...p.items.map((i) => i.id));
    cursor = p.next_cursor;
    pages += 1;
  } while (cursor);
  assert.deepEqual(seen, ids);
  assert.equal(pages, 3);
});

test('AC1 (re-indexing): changes since a time return only work orders created or updated after it', async () => {
  const { db, ids, at, tick } = await seeded();
  const since = '2026-10-30T09:03:30.000Z'; // after the 3rd work order was created
  assert.deepEqual(workOrderChanges(db, { since }).items.map((i) => i.id), [ids[3], ids[4]]);

  tick();
  await updateWorkOrder(db, ids[0], { priority: 'high' }, { actor: 'user-2', now: at });
  assert.deepEqual(workOrderChanges(db, { since }).items.map((i) => i.id), [ids[3], ids[4], ids[0]]);
});

test('AC1 (searching): keyword search finds matches in title, description, type and location', async () => {
  const { db, ids } = await seeded();
  const find = (q) => searchWorkOrders(db, { q }).items.map((i) => i.id);
  assert.deepEqual(find('streetlight'), [ids[1]]);
  assert.deepEqual(find('flickering'), [ids[1]], 'description');
  assert.deepEqual(find('REC CENTRE'), [ids[2]], 'case-insensitive, freeform location');
  assert.deepEqual(find('100%'), [ids[4]], '% is matched literally, not as a wildcard');
  assert.deepEqual(find('drain_'), [ids[4]], '_ is matched literally');
  assert.deepEqual(find('nothing like this'), []);
});

test('bad parameters are rejected with a clear message', async () => {
  const { db } = await seeded();
  assert.throws(() => listWorkOrders(db, { limit: 0 }), ValidationError);
  assert.throws(() => listWorkOrders(db, { limit: 500 }), ValidationError);
  assert.throws(() => listWorkOrders(db, { cursor: 'garbage' }), /cursor is not valid/);
  assert.throws(() => workOrderChanges(db, { since: 'last week' }), /since must be an ISO date-time/);
  assert.throws(() => searchWorkOrders(db, { q: 'a' }), /at least 2 characters/);
  assert.throws(() => getPublicWorkOrder(db, { id: 'nope' }), NotFoundError);
});

test('reads through the audited gate are logged with how many records were returned', async () => {
  const { db } = await seeded();
  const { key } = createApiClient(db, { name: 'Madison AI', actor: 'admin-1' });
  auditedRead(db, { key, operation: 'searchWorkOrders', params: { q: 'Example Way' } }, () => searchWorkOrders(db, { q: 'Example Way' }));
  const [entry] = accessAudits(db);
  assert.equal(JSON.parse(entry.after_json).records_returned, 4); // 4 of the 5 are on Example Way
});
