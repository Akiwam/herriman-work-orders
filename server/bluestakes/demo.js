// STORY-013 demo: a locator works Blue Stakes tickets through the API.
// Stand-in tickets, stand-in one-call centre, throwaway in-memory database, local port. Writes no files.
// Run with: npm run demo:tickets

import { openDatabase } from '../db.js';
import { createApiClient, LOCATE_TICKETS_SCOPE } from '../api/clients.js';
import { createApiServer } from '../api/server.js';
import { importLocateTicket, loadStandInTickets } from '../locateTickets.js';
import { createBlueStakesClient, createBlueStakesLogger, createStandInBlueStakes } from '../bluestakes.js';

const db = openDatabase(':memory:');
const line = () => console.log('-'.repeat(72));
const step = (n, text) => { line(); console.log(`STEP ${n} — ${text}`); line(); };

const centre = createStandInBlueStakes();
const bluestakes = createBlueStakesClient(centre, { log: createBlueStakesLogger(db), timeoutMs: 2000, attempts: 2, delayMs: 50 });
const cityApp = createApiClient(db, { name: 'City app', scopes: [LOCATE_TICKETS_SCOPE], actor: 'admin.demo' });
const madison = createApiClient(db, { name: 'Madison AI', actor: 'admin.demo' });
const server = createApiServer(db, { bluestakes });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
const call = async (method, path, body, key = cityApp.key) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  return { status: res.status, body: await res.json() };
};

console.log('\nHerriman City Work Orders — STORY-013 demo (Blue Stakes locate tickets)');
console.log('One-call centre: STAND-IN (made-up tickets, placeholder response codes — not the real Blue Stakes)\n');

step(1, 'Tickets arrive from the one-call centre feed');
const tickets = loadStandInTickets().map((t) => importLocateTicket(db, t));
for (const t of tickets) console.log(`  ${t.ticket_number}  ${t.ticket_type.padEnd(9)} ${t.status.padEnd(9)} due ${t.due_at}  ${t.work_description}`);
const again = importLocateTicket(db, loadStandInTickets()[0]);
console.log(`  The feed re-sends ${again.ticket_number}: duplicate=${again.duplicate} — still ${db.prepare('SELECT COUNT(*) n FROM locate_tickets').get().n} tickets`);

const [fence, emergency] = tickets;

step(2, 'The locator updates the emergency ticket (AC1)');
const upd = await call('PATCH', `/locate-tickets/${emergency.id}`, {
  actor: 'locator.demo', status: 'in_progress', marking_details: 'Water service marked in blue, 2 flags',
});
console.log(`  ${upd.status}  status=${upd.body.item.status}  marking_details="${upd.body.item.marking_details}"`);

step(3, 'The locator answers the one-call centre');
const resp = await call('POST', `/locate-tickets/${emergency.id}/respond`, { actor: 'locator.demo', code: 'marked', note: 'Marked within 1 hour' });
console.log(`  ${resp.status}  status=${resp.body.item.status}  code=${resp.body.item.response_code}  delivery=${resp.body.delivery}`);
console.log(`  One-call centre received: ${centre.received().map((r) => `${r.ticket_number} → ${r.response_code}`).join(', ')}`);

step(4, 'The locator completes it (AC2)');
const done = await call('POST', `/locate-tickets/${emergency.id}/complete`, { actor: 'locator.demo' });
console.log(`  ${done.status}  status=${done.body.item.status}  completed_at=${done.body.item.completed_at}`);

step(5, 'Rules hold: the fence ticket cannot be completed before it is answered');
const early = await call('POST', `/locate-tickets/${fence.id}/complete`, { actor: 'locator.demo' });
console.log(`  ${early.status}  ${early.body.error}: ${early.body.message}`);
const bad = await call('POST', `/locate-tickets/${fence.id}/respond`, { actor: 'locator.demo', code: 'all good' });
console.log(`  ${bad.status}  ${bad.body.error}: ${bad.body.problems.join('; ')}`);

step(6, 'Unauthorized access attempt: Madison AI\'s read-only key tries to change a ticket');
const denied = await call('PATCH', `/locate-tickets/${fence.id}`, { actor: 'someone', locator_notes: 'x' }, madison.key);
console.log(`  ${denied.status}  ${denied.body.error}: ${denied.body.message}`);

step(7, 'Audit trail for the tickets, and every refusal (AC3)');
const rows = db.prepare(`SELECT entity_type, entity_id, action, actor, after_json, occurred_at FROM audit_entries
                         WHERE entity_type IN ('locate_ticket', 'api_access') ORDER BY id`).all();
const numberOf = new Map(tickets.map((t) => [t.id, t.ticket_number]));
for (const r of rows) {
  const what = r.entity_type === 'locate_ticket' ? numberOf.get(r.entity_id) : `API ${JSON.parse(r.after_json).operation}`;
  const extra = r.action === 'denied' ? `  (${JSON.parse(r.after_json).reason})` : '';
  console.log(`  ${r.occurred_at}  ${r.action.padEnd(8)} ${what.padEnd(26)} by ${r.actor}${extra}`);
}

step(8, 'Every call to the one-call centre, with timestamps');
for (const l of db.prepare('SELECT * FROM bluestakes_log ORDER BY id').all()) {
  console.log(`  ${l.started_at}  ${l.operation}  ${l.ticket_number}  try ${l.attempt}  ${l.outcome}  ${l.duration_ms} ms`);
}

await new Promise((resolve) => server.close(resolve));
line();
console.log('Demo finished. API stopped; nothing was written to disk.\n');
