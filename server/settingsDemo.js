// STORY-008 demo: an administrator tailors the system — settings and user accounts — and every change
// is felt on the next request and recorded with who made it and when.
// Throwaway in-memory database and local port; nothing is saved.
// Run with: npm run demo:settings

import { openDatabase } from './db.js';
import { bootstrapAdministrator, issueUserKey, createUser, grantRole } from './access.js';
import { createWorkOrder } from './workOrders.js';
import { createApiServer } from './api/server.js';

const db = openDatabase(':memory:');
const line = () => console.log('-'.repeat(72));
const step = (n, text) => { line(); console.log(`STEP ${n} — ${text}`); line(); };

const admin = bootstrapAdministrator(db, { email: 'jane.admin@herriman.example', display_name: 'Jane Admin' });
const as = { actorUserId: admin.id };
const jane = issueUserKey(db, admin.id, as).key;
const person = (email, name, role) => {
  const user = createUser(db, { email, display_name: name }, as);
  if (role) grantRole(db, { userId: user.id, roleId: role }, as);
  return { ...user, key: issueUserKey(db, user.id, as).key };
};
const sam = person('sam@herriman.example', 'Sam Crew', 'field_crew');
const sue = person('sue@herriman.example', 'Sue Supervisor', 'supervisor');
const lee = person('lee@herriman.example', 'Lee Inspector', null);
const ava = person('ava@herriman.example', 'Ava Auditor', 'auditor');
await createWorkOrder(db, { title: 'Pothole', work_type: 'pothole', location_text: 'Stand-in', created_by: 'demo' });

const server = createApiServer(db);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
const call = async (method, path, key, { body, etag } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(etag ? { 'If-Match': etag } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, etag: res.headers.get('etag'), body: await res.json() };
};
const show = (label, r, extra = '') => console.log(`${label.padEnd(54)} → ${r.status}${r.status >= 400 ? `  ${r.body.message}` : extra}`);
let n = 0;
const citizen = () => ({ description: 'Pothole about a foot wide in the right-hand lane', location_text: 'Stand-in: 300 block of Example Way', category: 'pothole', submission_id: `demo-sub-${(n += 1).toString().padStart(4, '0')}` });

try {
  step(1, 'A setting applies across the system: the public site rate limit');
  const limit = await call('GET', '/settings/public.rate_limit_per_hour', jane);
  console.log(`public.rate_limit_per_hour = ${limit.body.item.value} (default ${limit.body.item.default}, range ${limit.body.item.min}–${limit.body.item.max}), ETag ${limit.etag}`);
  show('A citizen submits a request', await call('POST', '/public/requests', null, { body: citizen() }));
  const lowered = await call('PUT', '/settings/public.rate_limit_per_hour', jane, { body: { value: 1 }, etag: limit.etag });
  show('Jane lowers the limit to 1 per hour', lowered, `  now v${lowered.body.item.version}`);
  show('The same citizen submits again', await call('POST', '/public/requests', null, { body: citizen() }));
  const reset = await call('DELETE', '/settings/public.rate_limit_per_hour', jane, { etag: lowered.etag });
  show('Jane resets it to the default', reset, `  back to ${reset.body.item.value}`);
  show('The citizen submits again', await call('POST', '/public/requests', null, { body: citizen() }));

  step(2, 'Another setting: the default heat map cell size');
  const before = await call('GET', '/heat-maps', jane);
  console.log(`Heat map before: ${before.body.properties.params.cell_size_m} m cells`);
  await call('PUT', '/settings/heat_maps.default_cell_size_m', jane, { body: { value: 1000 }, etag: '"v0"' });
  console.log(`Jane sets 1000 m; the next heat map: ${(await call('GET', '/heat-maps', jane)).body.properties.params.cell_size_m} m cells`);

  step(3, 'Configuration that cannot be saved is refused, and nothing changes');
  show('Jane tries 5000 m (allowed: 50–2000)', await call('PUT', '/settings/heat_maps.default_cell_size_m', jane, { body: { value: 5000 }, etag: '"v1"' }));
  show('Jane saves from an old copy (v0)', await call('PUT', '/settings/heat_maps.default_cell_size_m', jane, { body: { value: 500 }, etag: '"v0"' }));
  show('Sue (supervisor) tries to change a setting', await call('PUT', '/settings/heat_maps.default_cell_size_m', sue.key, { body: { value: 500 }, etag: '"v1"' }));

  step(4, 'Managing a user account: changes show on the very next request');
  const samNow = await call('GET', `/users/${sam.id}`, jane);
  const renamed = await call('PATCH', `/users/${sam.id}`, jane, { body: { display_name: 'Samuel Crew' }, etag: samNow.etag });
  show('Jane renames Sam', renamed, `  "${renamed.body.item.display_name}", now ${renamed.etag}`);
  show('Sam creates a work order', await call('POST', '/work-orders', sam.key, { body: { title: 'Pothole on Main St', work_type: 'pothole', location_text: 'Stand-in' } }));
  show('Jane deactivates Sam', await call('POST', `/users/${sam.id}/deactivate`, jane));
  show('Sam tries again', await call('POST', '/work-orders', sam.key, { body: { title: 'Pothole', work_type: 'pothole', location_text: 'Stand-in' } }));
  show('Jane tries to deactivate herself', await call('POST', `/users/${admin.id}/deactivate`, jane));

  step(5, 'A role of the city\'s own');
  show('Jane creates "Inspector" (read + write work orders)', await call('POST', '/roles', jane, { body: { id: 'inspector', name: 'Inspector', description: 'Inspects repairs and signs them off.', permissions: ['work_orders:read', 'work_orders:write'] } }));
  await call('POST', `/users/${lee.id}/roles`, jane, { body: { role_id: 'inspector' } });
  show('Lee (Inspector) creates a work order', await call('POST', '/work-orders', lee.key, { body: { title: 'Kerb damage', work_type: 'kerb', location_text: 'Stand-in' } }));
  show('Jane narrows Inspector to read only', await call('PATCH', '/roles/inspector', jane, { body: { permissions: ['work_orders:read'] } }));
  show('Lee creates another work order', await call('POST', '/work-orders', lee.key, { body: { title: 'Kerb damage', work_type: 'kerb', location_text: 'Stand-in' } }));
  show('Jane tries to change the built-in Supervisor role', await call('PATCH', '/roles/supervisor', jane, { body: { permissions: ['work_orders:read'] } }));

  step(6, 'Trust: Ava (auditor) reads every configuration and account change, with user ids and times');
  const names = { [admin.id]: 'Jane' };
  for (const type of ['setting', 'user', 'role']) {
    const entries = (await call('GET', `/audit?entity_type=${type}`, ava.key)).body.items.filter((e) => e.actor_user_id);
    for (const e of entries) {
      const what = type === 'setting' ? `${e.entity_id}: ${e.before.value} → ${e.after.value}`
        : type === 'role' ? `${e.entity_id}${e.after?.permissions ? ` [${e.after.permissions.join(', ')}]` : ''}` : (e.after?.email ?? e.after?.display_name ?? e.entity_id.slice(0, 8));
      console.log(`${e.occurred_at}  ${(names[e.actor_user_id] ?? e.actor).padEnd(5)} ${type.padEnd(8)} ${e.action.padEnd(11)} ${what}  (user ${e.actor_user_id.slice(0, 8)}…)`);
    }
  }
  line();
} finally {
  server.close();
}
