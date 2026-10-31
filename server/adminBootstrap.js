// Set up the first system administrator (STORY-007), once, on a new database.
//
//   npm run admin:bootstrap -- --email jane@herriman.example --name "Jane Admin" [--db data/herriman.db]
//
// Prints their personal key ONCE, to this terminal only. It is not written to any file, log or the
// audit trail; give it to them directly. Refuses if the database already has a system administrator,
// so it cannot be used to take over a running system — after this, administrators add everyone else.
// The database file holds emails and key hashes: data/ and *.db are git-ignored so it never reaches the repo.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { openDatabase } from './db.js';
import { bootstrapAdministrator, issueUserKey } from './access.js';

const { values } = parseArgs({
  options: { email: { type: 'string' }, name: { type: 'string' }, db: { type: 'string', default: 'data/herriman.db' } },
});
if (!values.email || !values.name) {
  console.error('Usage: npm run admin:bootstrap -- --email <email> --name "<display name>" [--db data/herriman.db]');
  process.exit(2);
}

try {
  if (values.db !== ':memory:') mkdirSync(dirname(values.db), { recursive: true });
  const db = openDatabase(values.db);
  const admin = bootstrapAdministrator(db, { email: values.email, display_name: values.name });
  const { key } = issueUserKey(db, admin.id, { actorUserId: admin.id });
  db.close();
  console.log(`First system administrator: ${admin.display_name} <${admin.email}> (user ${admin.id})`);
  console.log('Their personal key is below. It is shown once and cannot be recovered; give it to them directly.');
  console.log(key);
} catch (err) {
  console.error(`Not done: ${err.message}`);
  process.exit(1);
}
