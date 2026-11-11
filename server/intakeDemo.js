// STORY-015 demo: AI-first intake — the agent drafts, a named person approves.
// Throwaway in-memory database; nothing is saved.
// Run with: npm run demo:intake

import { openDatabase } from './db.js';
import { bootstrapAdministrator, createUser, grantRole } from './access.js';
import { submitPublicRequest, getPublicView } from './publicRequests.js';
import { loadStandInTickets } from './locateTickets.js';
import { receiveLocateTicket, listDrafts, approveDraft, rejectDraft, correctDraft, proposeDraft, getDraft } from './intake.js';

const db = openDatabase(':memory:');
const line = () => console.log('-'.repeat(72));
const step = (n, text) => { line(); console.log(`STEP ${n} — ${text}`); line(); };
const admin = bootstrapAdministrator(db, { email: 'jane.admin@herriman.example', display_name: 'Jane Admin' });
const person = (email, name, role) => {
  const u = createUser(db, { email, display_name: name }, { actorUserId: admin.id });
  grantRole(db, { userId: u.id, roleId: role }, { actorUserId: admin.id });
  return u;
};
const sue = person('sue@herriman.example', 'Sue Supervisor', 'supervisor');
const ray = person('ray@herriman.example', 'Ray Supervisor', 'supervisor');
const sam = person('sam@herriman.example', 'Sam Crew', 'field_crew');
const workOrders = () => db.prepare('SELECT COUNT(*) AS n FROM work_orders').get().n;
const show = (d) => `${d.proposed.title} | type=${d.proposed.work_type ?? '(not determined)'} | priority=${d.proposed.priority} | performs: ${d.performer} | must approve: ${d.approver}`;
let n = 0;
const citizen = async (description, category) => {
  const r = await submitPublicRequest(db, { description, category, location_text: '13400 S Rosecrest Rd (stand-in)', contact: 'resident@example.com', submission_id: `demo-intake-${(n += 1)}` }, { ip: '192.0.2.50' });
  const req = db.prepare('SELECT id FROM service_requests WHERE tracking_code = ?').get(r.tracking_code);
  return { code: r.tracking_code, draft: listDrafts(db).find((d) => d.source_id === req.id) };
};

step(1, 'A citizen request and a Blue Stakes ticket arrive: each becomes a drafted work order, fields filled in');
const pothole = await citizen('Large pothole in the right-hand lane, cars are swerving around it', 'pothole');
const { draft: locate } = await receiveLocateTicket(db, loadStandInTickets()[1]);
console.log(`Citizen ${pothole.code}: ${show(pothole.draft)}`);
console.log(`Blue Stakes:        ${show(locate)}`);
console.log(`Drafted by: ${pothole.draft.drafted_by}. Work orders in the live list: ${workOrders()}`);
console.log(`The citizen sees: "${getPublicView(db, { trackingCode: pothole.code }).status}"`);

step(2, 'A field the agent could not determine is left empty, with the reason — never guessed');
const vague = await citizen('Something strange near the park fence, please take a look', 'citizen_request');
console.log(show(vague.draft));
console.log(`Undetermined: ${vague.draft.undetermined.map((u) => `${u.field} (${u.reason})`).join('; ')}`);
const blocked = await approveDraft(db, vague.draft.id, { actorUserId: sue.id }).catch((e) => e);
console.log(`Sue approves as it is → refused: ${blocked.problems?.[0]}`);

step(3, 'Sue corrects and approves; the work order names her; the agent\'s proposal is kept');
correctDraft(db, pothole.draft.id, { changes: { priority: 'high' }, actorUserId: sue.id });
const { workOrder } = await approveDraft(db, pothole.draft.id, { actorUserId: sue.id });
const decided = getDraft(db, pothole.draft.id);
console.log(`Work order ${workOrder.id.slice(0, 8)}… created by ${workOrder.created_by}, priority ${workOrder.priority}`);
console.log(`Agent proposed priority: ${decided.proposed.priority}  →  Sue's version: ${decided.final.priority}  (both kept)`);
console.log(`The citizen now sees: "${getPublicView(db, { trackingCode: pothole.code }).status}"`);

step(4, 'Two reviewers approve the same draft at the same time: one work order');
const before = workOrders();
const both = await Promise.allSettled([approveDraft(db, locate.id, { actorUserId: sue.id }), approveDraft(db, locate.id, { actorUserId: ray.id })]);
for (const r of both) console.log(r.status === 'fulfilled' ? `  approved → work order ${r.value.workOrder.id.slice(0, 8)}…` : `  refused → ${r.reason.message}`);
console.log(`Work orders created: ${workOrders() - before}`);

step(5, 'An approval after the source changed is refused; it is re-drafted');
const water = await citizen('Water bubbling up through the sidewalk outside the library', 'water_leak');
db.prepare('UPDATE service_requests SET location_text = ? WHERE tracking_code = ?').run('55 Sample Ave (stand-in), corrected by the citizen', water.code);
const stale = await approveDraft(db, water.draft.id, { actorUserId: sue.id }).catch((e) => e);
console.log(`Sue approves the old draft → ${stale.message}`);
const redrafted = await proposeDraft(db, { sourceType: 'citizen_request', sourceId: water.draft.source_id });
console.log(`Re-drafted: location now "${redrafted.proposed.location_text}"; the old draft is ${getDraft(db, water.draft.id).status}`);

step(6, 'Reject: nothing reaches the live list; the citizen is told only that it will not be taken forward');
rejectDraft(db, vague.draft.id, { reason: 'Not city property: private fence', actorUserId: sue.id });
console.log(`Citizen ${vague.code} sees: "${getPublicView(db, { trackingCode: vague.code }).status}" (the reason stays internal)`);
const crew = await approveDraft(db, redrafted.id, { actorUserId: sam.id }).catch((e) => e);
console.log(`Sam (field crew) tries to approve → ${crew.message}`);

step(7, 'Trust: who decided each draft, from the audit trail');
for (const e of db.prepare("SELECT occurred_at, action, actor, entity_id FROM audit_entries WHERE entity_type = 'intake_draft' ORDER BY id").all()) {
  console.log(`${e.occurred_at}  ${e.action.padEnd(10)} ${e.actor}  (draft ${e.entity_id.slice(0, 8)}…)`);
}
line();
