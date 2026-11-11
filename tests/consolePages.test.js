// STORY-014 step 3 — the console's screens: served safely, signed in as a real person, and every
// screen fits 1440x900 with no horizontal scrollbar.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../server/db.js';
import { bootstrapAdministrator, issueUserKey } from '../server/access.js';
import { createApiServer } from '../server/api/server.js';
import { startSession } from '../server/consoleSessions.js';
import { runLayoutCheck, edgeAvailable } from '../server/consoleLayoutCheck.js';

async function start() {
  const db = openDatabase();
  const admin = bootstrapAdministrator(db, { email: 'jane.admin@herriman.example', display_name: 'Jane Admin' });
  const key = issueUserKey(db, admin.id, { actorUserId: admin.id }).key;
  const server = createApiServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, key, base, stop: () => new Promise((resolve) => server.close(resolve)) };
}

test('the console is served with the same strict security headers as the public page, and no inline code or styles', async (t) => {
  const { base, stop } = await start();
  t.after(stop);
  const page = await fetch(`${base}/console`);
  assert.equal(page.status, 200);
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'/);
  const html = await page.text();
  assert.doesNotMatch(html, /<script>|style="/, 'nothing inline, so the strict policy allows the page');
  const js = await (await fetch(`${base}/console/app.js`)).text();
  assert.doesNotMatch(js, /style="/, 'no inline style attributes: the policy would block them');
  assert.doesNotMatch(js, /localStorage/, 'the session is kept for this tab only');
  assert.equal((await fetch(`${base}/console/styles.css`)).status, 200);
  assert.equal((await fetch(`${base}/console`, { method: 'POST' })).status, 405);
});

test('the console knows who is signed in, and only from a valid session', async (t) => {
  const { db, key, base, stop } = await start();
  t.after(stop);
  const { token } = startSession(db, key);
  const me = await fetch(`${base}/api/v1/console/me`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await me.json();
  assert.deepEqual([me.status, body.display_name, body.email], [200, 'Jane Admin', 'jane.admin@herriman.example']);
  assert.ok(body.permissions.includes('work_orders:write'));
  assert.equal((await fetch(`${base}/api/v1/console/me`)).status, 401);
});

test('every console screen renders at 1440x900 with no horizontal scrollbar', { skip: !edgeAvailable() && 'Edge is not installed here', timeout: 600000 }, async () => {
  const results = await runLayoutCheck();
  for (const r of results) assert.ok(r.fits, `${r.screen}: ${r.result}`);
  assert.equal(results.length, 13);
});
