// STORY-013 over real HTTP: update, respond and complete locate tickets through the API.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../server/db.js';
import { createApiClient, LOCATE_TICKETS_SCOPE } from '../server/api/clients.js';
import { createApiServer } from '../server/api/server.js';
import { importLocateTicket, loadStandInTickets, getLocateTicket } from '../server/locateTickets.js';
import { createBlueStakesClient, createBlueStakesLogger, createStandInBlueStakes } from '../server/bluestakes.js';

async function start() {
  const db = openDatabase();
  const ticket = importLocateTicket(db, structuredClone(loadStandInTickets()[0]));
  const centre = createStandInBlueStakes();
  const bluestakes = createBlueStakesClient(centre, { log: createBlueStakesLogger(db), timeoutMs: 500, attempts: 2, delayMs: 1 });
  const cityApp = createApiClient(db, { name: 'City app', scopes: [LOCATE_TICKETS_SCOPE], actor: 'admin-1' });
  const madison = createApiClient(db, { name: 'Madison AI', actor: 'admin-1' }); // read-only work order scope
  const server = createApiServer(db, { bluestakes });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (method, path, { key = cityApp.key, body } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
      signal: AbortSignal.timeout(5000),
    });
    return { status: res.status, body: await res.json() };
  };
  const stop = () => new Promise((resolve) => server.close(resolve));
  return { db, ticket, centre, cityApp, madison, call, stop };
}

const ticketAudits = (db, id) => db.prepare("SELECT action, actor FROM audit_entries WHERE entity_type = 'locate_ticket' AND entity_id = ? ORDER BY id").all(id);
const denials = (db) => db.prepare("SELECT actor, after_json FROM audit_entries WHERE entity_type = 'api_access' AND action = 'denied' ORDER BY id").all();

test('the full ticket journey over HTTP: view, update, respond, complete — each change audited (AC1, AC2, AC3)', async (t) => {
  const { db, ticket, centre, call, stop } = await start();
  t.after(stop);
  const path = `/locate-tickets/${ticket.id}`;

  const view = await call('GET', path);
  assert.equal(view.status, 200);
  assert.equal(view.body.item.ticket_number, 'SI-2026-000101');

  // AC1: update is reflected accurately
  const upd = await call('PATCH', path, { body: { actor: 'locator-1', status: 'in_progress', marking_details: 'Blue paint, 3 flags' } });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.item.marking_details, 'Blue paint, 3 flags');
  assert.equal(getLocateTicket(db, ticket.id).status, 'in_progress');

  const resp = await call('POST', `${path}/respond`, { body: { actor: 'locator-1', code: 'marked', note: 'All marked' } });
  assert.equal(resp.status, 200);
  assert.equal(resp.body.item.status, 'responded');
  assert.equal(resp.body.delivery, 'delivered');
  assert.equal(centre.received()[0].response_code, 'marked');

  // AC2: completing sets the status to completed
  const done = await call('POST', `${path}/complete`, { body: { actor: 'locator-1' } });
  assert.equal(done.status, 200);
  assert.equal(done.body.item.status, 'completed');

  // AC3: every change is in the audit trail, naming the person and the system they used
  assert.deepEqual(ticketAudits(db, ticket.id).map((row) => ({ ...row })), [ // rows → plain objects for comparison
    { action: 'import', actor: 'bluestakes-feed' },
    { action: 'update', actor: 'locator-1 via City app' },
    { action: 'respond', actor: 'locator-1 via City app' },
    { action: 'complete', actor: 'locator-1 via City app' },
  ]);
});

// ---------- failure path: unauthorized access attempt ----------

test('no key or a wrong key gets 401, the attempt is audited, and the ticket is unchanged', async (t) => {
  const { db, ticket, call, stop } = await start();
  t.after(stop);
  for (const key of [null, 'hwo_deadbeef_notarealkeyatall']) {
    const r = await call('PATCH', `/locate-tickets/${ticket.id}`, { key, body: { actor: 'intruder', locator_notes: 'x' } });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'unauthorized');
  }
  assert.equal(getLocateTicket(db, ticket.id).locator_notes, null);
  assert.deepEqual(denials(db).map((d) => d.actor), ['anonymous', 'anonymous']);
});

test("Madison AI's read-only key gets 403 on tickets, and the attempt is audited under its name", async (t) => {
  const { db, ticket, madison, call, stop } = await start();
  t.after(stop);
  for (const [method, path] of [['GET', ''], ['PATCH', ''], ['POST', '/complete']]) {
    const r = await call(method, `/locate-tickets/${ticket.id}${path}`, { key: madison.key, body: method === 'GET' ? undefined : { actor: 'x' } });
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.equal(r.body.error, 'forbidden');
  }
  const d = denials(db);
  assert.equal(d.length, 3);
  assert.ok(d.every((x) => x.actor === 'Madison AI' && JSON.parse(x.after_json).reason === `missing scope ${LOCATE_TICKETS_SCOPE}`));
});

// ---------- failure paths: not found, invalid format, not allowed ----------

test('an unknown ticket gets 404', async (t) => {
  const { call, stop } = await start();
  t.after(stop);
  assert.equal((await call('GET', '/locate-tickets/no-such-ticket')).status, 404);
  assert.equal((await call('PATCH', '/locate-tickets/no-such-ticket', { body: { actor: 'locator-1', locator_notes: 'x' } })).status, 404);
  assert.equal((await call('POST', '/locate-tickets/no-such-ticket/complete', { body: { actor: 'locator-1' } })).status, 404);
});

test('invalid data gets 400 with the problems listed', async (t) => {
  const { ticket, call, stop } = await start();
  t.after(stop);
  const path = `/locate-tickets/${ticket.id}`;
  const notJson = await call('PATCH', path, { body: '{not json' });
  assert.equal(notJson.status, 400);
  assert.deepEqual(notJson.body.problems, ['request body must be valid JSON']);
  const noActor = await call('PATCH', path, { body: { locator_notes: 'x' } });
  assert.deepEqual(noActor.body.problems, ['actor is required']);
  const badField = await call('PATCH', path, { body: { actor: 'locator-1', response_code: 'marked' } });
  assert.ok(badField.body.problems.includes('response_code cannot be changed by an update'));
  const badCode = await call('POST', `${path}/respond`, { body: { actor: 'locator-1', code: 'sorted' } });
  assert.equal(badCode.status, 400);
  assert.match(badCode.body.problems[0], /code must be one of/);
  const array = await call('PATCH', path, { body: '[1,2]' });
  assert.deepEqual(array.body.problems, ['request body must be a JSON object']);
});

test('the OpenAPI contract describes the ticket endpoints and matches a real ticket', async (t) => {
  const { ticket, call, stop } = await start();
  t.after(stop);
  const doc = (await call('GET', '/openapi.json', { key: null })).body;
  assert.ok(doc.paths['/locate-tickets/{id}'].get && doc.paths['/locate-tickets/{id}'].patch);
  assert.ok(doc.paths['/locate-tickets/{id}/respond'].post && doc.paths['/locate-tickets/{id}/complete'].post);
  const real = (await call('GET', `/locate-tickets/${ticket.id}`)).body.item;
  assert.deepEqual(Object.keys(real).sort(), [...doc.components.schemas.LocateTicket.required].sort(), 'contract fields = real fields');
});

test('completing before responding gets 409, and the wrong method gets 405', async (t) => {
  const { ticket, call, stop } = await start();
  t.after(stop);
  const early = await call('POST', `/locate-tickets/${ticket.id}/complete`, { body: { actor: 'locator-1' } });
  assert.equal(early.status, 409);
  assert.match(early.body.message, /Respond to the one-call centre/);
  assert.equal((await call('DELETE', `/locate-tickets/${ticket.id}`)).status, 405);
  assert.equal((await call('GET', `/locate-tickets/${ticket.id}/complete`)).status, 405);
});
