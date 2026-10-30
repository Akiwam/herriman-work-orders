// STORY-003 — the public web page is served safely.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../server/db.js';
import { createApiServer } from '../server/api/server.js';

async function start() {
  const server = createApiServer(openDatabase());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = (path, method = 'GET') => fetch(`${origin}${path}`, { method, signal: AbortSignal.timeout(5000) });
  return { get, stop: () => new Promise((resolve) => server.close(resolve)) };
}

test('the public page and its files are served with strict security headers', async (t) => {
  const { get, stop } = await start();
  t.after(stop);
  for (const [path, type] of [['/public', 'text/html'], ['/public/app.js', 'text/javascript'], ['/public/styles.css', 'text/css']]) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type'), new RegExp(`^${type}`), path);
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'; script-src 'self'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
  }
  const html = await (await get('/public')).text();
  assert.match(html, /<form id="report-form"/);
  assert.match(html, /IP addresses are deleted after 90 days/, 'the page says the IP is recorded');
});

test('nothing else on the server can be reached through the page path', async (t) => {
  const { get, stop } = await start();
  t.after(stop);
  for (const path of ['/public/../db.js', '/public/%2e%2e/workOrders.js', '/public/index.html.bak', '/public/server.js', '/public/app.js/']) {
    assert.equal((await get(path)).status, 404, path);
  }
  assert.equal((await get('/public', 'POST')).status, 405);
});

test('the page script never inserts server data as HTML', async (t) => {
  const { get, stop } = await start();
  t.after(stop);
  const js = await (await get('/public/app.js')).text();
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(js, /crypto\.randomUUID\(\)/, 'each report carries its own submission id');
});
