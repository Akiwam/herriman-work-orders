// STORY-007 demo: an administrator manages who can do what, people act with their own keys, and an
// auditor reads the audit trail. Throwaway in-memory database and local port; nothing is saved.
// Keys are shortened when printed — a real key is shown once, in full, only to the administrator.
// Run with: npm run demo:access

import { openDatabase } from './db.js';
import { bootstrapAdministrator, issueUserKey } from './access.js';
import { createApiServer } from './api/server.js';

const db = openDatabase(':memory:');
const line = () => console.log('-'.repeat(72));
const step = (n, text) => { line(); console.log(`STEP ${n} — ${text}`); line(); };
const short = (key) => `${key.slice(0, 13)}…`;

const server = createApiServer(db);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
const call = async (method, path, key, { body, etag } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(etag ? { 'If-Match': etag } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, etag: res.headers.get('etag'), body: await res.json() };
};
const show = (label, r) => console.log(`${label.padEnd(52)} → ${r.status}${r.status >= 400 ? `  ${r.body.message}` : ''}`);
const pothole = { title: 'Pothole on Rosecrest', work_type: 'pothole', location_text: 'Stand-in: 13400 S Rosecrest Rd' };

try {
  step(1, 'The first administrator is set up (npm run admin:bootstrap does this on a real database)');
  const admin = bootstrapAdministrator(db, { email: 'jane.admin@herriman.example', display_name: 'Jane Admin' });
  const jane = issueUserKey(db, admin.id, { actorUserId: admin.id }).key;
  console.log(`${admin.display_name} <${admin.email}>, roles ${admin.roles.join(', ')}, key ${short(jane)}`);

  step(2, 'Jane adds three people and gives each a role and a personal key');
  const people = {};
  for (const [email, name, role] of [
    ['sam@herriman.example', 'Sam Crew', 'field_crew'],
    ['sue@herriman.example', 'Sue Supervisor', 'supervisor'],
    ['ava@herriman.example', 'Ava Auditor', 'auditor'],
  ]) {
    const user = (await call('POST', '/users', jane, { body: { email, display_name: name } })).body.item;
    await call('POST', `/users/${user.id}/roles`, jane, { body: { role_id: role } });
    const key = (await call('POST', `/users/${user.id}/key`, jane)).body.key;
    people[name.split(' ')[0].toLowerCase()] = { ...user, key };
    console.log(`${name.padEnd(16)} ${role.padEnd(12)} key ${short(key)}`);
  }
  const { sam, sue, ava } = people;

  step(3, 'Sam (field crew) can do field work — and nothing else');
  const wo = await call('POST', '/work-orders', sam.key, { body: pothole });
  show('Sam creates a work order', wo);
  show('Sam opens the heat maps', await call('GET', '/heat-maps', sam.key));
  show('Sam tries to make himself an administrator', await call('POST', `/users/${sam.id}/roles`, sam.key, { body: { role_id: 'system_admin' } }));
  show('Sam reads the audit trail', await call('GET', '/audit', sam.key));

  step(4, 'Only a supervisor can sign off a pothole repair');
  const published = await call('POST', '/workflows', sue.key, {
    body: {
      key: 'pothole_repair', name: 'Pothole repair', work_type: 'pothole',
      steps: [
        { key: 'received', name: 'Received', next: ['repaired'] },
        { key: 'repaired', name: 'Repaired', next: ['completed'] },
        { key: 'completed', name: 'Signed off', next: [], final: true, role: 'supervisor' },
      ],
    },
  });
  show('Sue publishes a workflow: sign-off needs supervisor', published);
  let job = await call('POST', '/work-orders', sam.key, { body: { ...pothole, title: 'Pothole on Main St' } });
  job = await call('POST', `/work-orders/${job.body.item.id}/transition`, sam.key, { body: { to: 'repaired' }, etag: job.etag });
  show('Sam marks it repaired', job);
  show('Sam tries to sign it off', await call('POST', `/work-orders/${job.body.item.id}/complete`, sam.key, { body: { note: 'Filled' }, etag: job.etag }));
  show('Sue signs it off', await call('POST', `/work-orders/${job.body.item.id}/complete`, sue.key, { body: { note: 'Inspected, signed off' }, etag: job.etag }));

  step(5, 'Nobody can act under someone else\'s name');
  show('Sam sends actor = jane.admin@herriman.example', await call('POST', '/work-orders', sam.key, { body: { ...pothole, actor: 'jane.admin@herriman.example' } }));

  step(6, 'Jane removes Sam\'s role: his very next request is refused');
  await call('DELETE', `/users/${sam.id}/roles/field_crew`, jane);
  show('Sam creates a work order', await call('POST', '/work-orders', sam.key, { body: pothole }));
  show('Jane removes her own administrator role (last one)', await call('DELETE', `/users/${admin.id}/roles/system_admin`, jane));

  step(7, 'Trust: Ava (auditor) reads every access change, with user ids and times');
  const changes = await call('GET', '/audit?entity_type=user_role', ava.key);
  const names = Object.fromEntries([[admin.id, 'Jane'], ...Object.values(people).map((p) => [p.id, p.display_name.split(' ')[0]])]);
  for (const e of changes.body.items) {
    const what = e.after.granted ? `granted ${e.after.granted}` : `removed ${e.after.revoked}`;
    console.log(`${e.occurred_at}  ${(names[e.actor_user_id] ?? e.actor).padEnd(8)} ${what.padEnd(26)} for ${names[e.entity_id]}  (${e.actor_user_id ? `by user ${e.actor_user_id.slice(0, 8)}…` : e.actor})`);
  }
  line();
  console.log('Everything Sam did, from the audit trail:');
  const samTrail = await call('GET', `/audit?user_id=${sam.id}`, ava.key);
  for (const e of samTrail.body.items) console.log(`${e.occurred_at}  ${e.entity_type.padEnd(11)} ${e.action.padEnd(11)} ${e.after?.operation ?? e.after?.title ?? ''}${e.after?.reason ? `  (${e.after.reason})` : ''}`);
  line();
} finally {
  server.close();
}
