// Run the staff console locally with example data (STORY-014), for trying it out and for recording
// the working-system demo.
//
//   npm run console            then open the address it prints
//
// Throwaway in-memory database: nothing is saved, and the example keys printed below stop existing
// when you stop this (Ctrl+C). They are not real keys for any real system.

import { exampleSystem, CONNECTIONS } from './consoleLayoutCheck.js';
import { createApiServer } from './api/server.js';

const port = Number(process.env.PORT ?? 4100);
const { db, gis, key, samKey } = await exampleSystem({ workOrders: 24 });
const server = createApiServer(db, { gis, connections: CONNECTIONS });
server.listen(port, '127.0.0.1', () => {
  console.log('Herriman Work Orders staff console (example data, nothing is saved)');
  console.log(`  Open:  http://127.0.0.1:${port}/console`);
  console.log('  Sign in with one of these example personal keys:');
  console.log(`    Jane Admin (system administrator):  ${key}`);
  console.log(`    Sam Crew (field crew):              ${samKey}`);
  console.log('  Stop with Ctrl+C.');
});
