// Try the public site yourself: npm run public  (then open the printed address).
// Uses an in-memory database with a few sample published work orders; everything is gone when you stop it.
// Set PORT to use a different port.

import { openDatabase } from '../db.js';
import { completeWorkOrder } from '../workOrders.js';
import { createApiServer } from '../api/server.js';
import { submitPublicRequest, publishWorkOrder } from '../publicRequests.js';
import { bootstrapAdministrator } from '../access.js';
import { approveDraft, listDrafts } from '../intake.js';

const db = openDatabase(':memory:');
// Since STORY-015 a request becomes a work order when a person approves its draft; a sample reviewer does that here.
const reviewer = bootstrapAdministrator(db, { email: 'sample.reviewer@herriman.example', display_name: 'Sample Reviewer' });
const samples = [
  ['Streetlight out by the bus stop for a week', 'Stand-in address: 140 Example Way', 'streetlight', false],
  ['Pothole about a foot wide in the right-hand lane', 'Stand-in address: Demo Blvd, east side', 'pothole', true],
  ['Graffiti on the park fence', 'Stand-in park, north entrance', 'graffiti', false],
];
for (const [i, [description, location_text, category, completed]] of samples.entries()) {
  const r = await submitPublicRequest(db, { description, location_text, category, submission_id: `sample-${i + 1}-seed` }, { ip: '192.0.2.1' });
  const { id: requestId } = db.prepare('SELECT id FROM service_requests WHERE tracking_code = ?').get(r.tracking_code);
  const draft = listDrafts(db).find((d) => d.source_id === requestId);
  const { workOrder } = await approveDraft(db, draft.id, { actorUserId: reviewer.id });
  const woId = workOrder.id;
  publishWorkOrder(db, woId, { actor: 'sample.staff' });
  if (completed) await completeWorkOrder(db, woId, { note: 'Patched', actor: 'sample.crew' });
}

const port = Number(process.env.PORT ?? 8080);
const server = createApiServer(db);
server.listen(port, '127.0.0.1', () => {
  console.log('\nHerriman City public site (sample data, in memory)');
  console.log(`  Open:  http://127.0.0.1:${port}/public`);
  console.log('  Stop:  Ctrl+C\n');
});
process.on('SIGINT', () => server.close(() => process.exit(0)));
