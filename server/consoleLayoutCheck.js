// Automatic 1440x900 check for the staff console (STORY-014): "every screen renders without a
// horizontal scrollbar so it can be captured for the proposal exhibit."
//
// Starts a throwaway in-memory system with example data, signs in, then opens every console screen in
// a headless Edge window of exactly 1440x900. The console marks <html data-layout-check="ok"> when the
// page fits the window, or "overflow:N" with the extra pixels when it does not. With --screenshots
// <folder>, it also saves a 1440x900 PNG of each screen for the proposal exhibit.
//
//   npm run console:check -- [--screenshots <folder>]
//
// Edge is found at its standard Windows location, or set EDGE_PATH. Exit code 0 = every screen fits.

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { openDatabase } from './db.js';
import { bootstrapAdministrator, issueUserKey, createUser, grantRole } from './access.js';
import { createWorkOrder, updateWorkOrder, assignWorkOrder } from './workOrders.js';
import { createGisClient, createGisLogger, createStandInGis, loadStandInAssets } from './gis.js';
import { createApiServer } from './api/server.js';
import { startSession } from './consoleSessions.js';
import { submitPublicRequest } from './publicRequests.js';
import { loadStandInTickets } from './locateTickets.js';
import { receiveLocateTicket, approveDraft, listDrafts } from './intake.js';

const run = promisify(execFile);
export const EDGE = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
export const edgeAvailable = () => existsSync(EDGE);

/** A throwaway system with enough example data to fill every screen. */
export async function exampleSystem({ workOrders = 60 } = {}) {
  const db = openDatabase(':memory:');
  const admin = bootstrapAdministrator(db, { email: 'jane.admin@herriman.example', display_name: 'Jane Admin' });
  const as = { actorUserId: admin.id };
  const sam = createUser(db, { email: 'sam@herriman.example', display_name: 'Sam Crew' }, as);
  grantRole(db, { userId: sam.id, roleId: 'field_crew' }, as);
  const key = issueUserKey(db, admin.id, as).key;
  const samKey = issueUserKey(db, sam.id, as).key;
  const gis = createGisClient(createStandInGis(loadStandInAssets()), { log: createGisLogger(db), timeoutMs: 1000, attempts: 2, delayMs: 10 });
  const types = ['pothole', 'streetlight', 'water_leak', 'hydrant', 'graffiti'];
  let detailId = null;
  for (let i = 0; i < workOrders; i += 1) {
    const at = new Date(Date.UTC(2026, 9, 1 + (i % 30), 8 + (i % 9))).toISOString();
    const input = i === 0
      ? { title: 'Streetlight out at the corner of a very long street name that keeps going to test how the table copes', created_by: 'clerk.example', asset_ids: ['SL-0001'] }
      : { title: `${types[i % types.length].replace('_', ' ')} report ${i + 1}`, work_type: types[i % types.length], location_text: `Stand-in location ${i + 1}, Example Way`, created_by: 'clerk.example' };
    const wo = await createWorkOrder(db, input, { gis, now: () => at });
    if (i % 3 === 0) assignWorkOrder(db, wo.id, { assigneeUserId: sam.id, actor: 'jane.admin@herriman.example' });
    if (i === 0) {
      detailId = wo.id;
      await updateWorkOrder(db, wo.id, { priority: 'high', description: 'Reported by a resident; the pole is leaning slightly.' }, { actor: 'jane.admin@herriman.example' });
    }
  }
  // AI intake (STORY-015): citizen requests and Blue Stakes tickets arrive as drafts; one is approved.
  const asks = [
    ['Large pothole in the right-hand lane, cars are swerving around it', 'pothole', '13400 S Rosecrest Rd (stand-in)'],
    ['Something strange near the park fence, please take a look', 'citizen_request', 'Stand-in park, north entrance'],
    ['Water bubbling up through the sidewalk outside the library, flooding the path', 'water_leak', '55 Sample Ave (stand-in)'],
  ];
  for (const [i, [description, category, location_text]] of asks.entries()) {
    await submitPublicRequest(db, { description, category, location_text, submission_id: `example-intake-${i + 1}` }, { ip: '192.0.2.10' });
  }
  for (const t of loadStandInTickets().slice(0, 2)) await receiveLocateTicket(db, t);
  const drafts = listDrafts(db);
  const undeterminedDraftId = drafts.find((d) => d.undetermined.length)?.id;
  const { workOrder: approved } = await approveDraft(db, drafts.find((d) => d.proposed.work_type === 'pothole').id, { actorUserId: admin.id, changes: { priority: 'high' } });
  return { db, gis, key, samKey, detailId, undeterminedDraftId, approvedWorkOrderId: approved.id };
}

/** Open every screen at 1440x900 and report whether each fits. */
export async function runLayoutCheck({ screenshots = null } = {}) {
  const { db, gis, key, detailId, undeterminedDraftId, approvedWorkOrderId } = await exampleSystem();
  const server = createApiServer(db, { gis });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/console`;
  const { token } = startSession(db, key);
  const profile = mkdtempSync(join(tmpdir(), 'hwo-edge-'));
  // [name, address, text the screen must show] — the text proves the real screen rendered, not a
  // fallback such as the sign-in page, which would also "fit".
  const screens = [
    ['sign-in', '', /Personal key/],
    ['work order list', `#/work-orders?session=${token}`, /61 work orders/],
    ['work order list, page 2', null, /Next page/], // address filled in below with a real cursor
    ['work order detail', `#/work-orders/${detailId}?session=${token}`, /GIS record[\s\S]*History/],
    ['empty list (filtered)', `#/work-orders?status=completed&session=${token}`, /No work orders match these filters/],
    ['AI intake queue', `#/intake?session=${token}`, /Must approve[\s\S]*Work type needed/],
    ['AI intake draft (field to fill in)', `#/intake/${undeterminedDraftId}?session=${token}`, /Agent proposed[\s\S]*not determined[\s\S]*Approve and create the work order/],
    ['work order approved from AI intake', `#/work-orders/${approvedWorkOrderId}?session=${token}`, /From AI intake[\s\S]*Approved by/],
    ['map (placeholder)', `#/map?session=${token}`, /STORY-016 · coming next<\/p>/],
    ['administration (placeholder)', `#/admin?session=${token}`, /STORY-017 · coming next<\/p>/],
    ['integrations & readiness (placeholder)', `#/integrations?session=${token}`, /STORY-018 · coming next<\/p>/],
  ];
  const first = await fetch(`${base.replace('/console', '/api/v1')}/console/work-orders`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
  screens[2][1] = `#/work-orders?cursor=${first.next_cursor}&session=${token}`;

  const results = [];
  try {
    if (screenshots) mkdirSync(screenshots, { recursive: true });
    for (const [name, hash, expect] of screens) {
      const url = `${base}${hash}`;
      const common = ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`, '--window-size=1440,900', '--virtual-time-budget=6000'];
      const { stdout } = await run(EDGE, [...common, '--dump-dom', url], { timeout: 60000, maxBuffer: 20 * 1024 * 1024 });
      const mark = /data-layout-check="([^"]+)"/.exec(stdout)?.[1] ?? 'not rendered';
      const rendered = expect.test(stdout);
      results.push({ screen: name, fits: mark === 'ok' && rendered, result: rendered ? mark : `${mark}, but the expected screen did not render` });
      if (screenshots) {
        const file = resolve(screenshots, `${name.replace(/[^a-z0-9]+/gi, '-').replace(/-$/, '').toLowerCase()}.png`);
        await run(EDGE, [...common, '--hide-scrollbars', `--screenshot=${file}`, url], { timeout: 60000 });
      }
    }
  } finally {
    server.close();
    rmSync(profile, { recursive: true, force: true });
  }
  return results;
}

// Run from the command line.
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  if (!edgeAvailable()) {
    console.error(`Edge not found at ${EDGE}. Set EDGE_PATH to a Chromium-based browser.`);
    process.exit(2);
  }
  const i = process.argv.indexOf('--screenshots');
  const results = await runLayoutCheck({ screenshots: i > 0 ? process.argv[i + 1] : null });
  for (const r of results) console.log(`${r.fits ? 'FITS ' : 'FAILS'}  ${r.screen.padEnd(40)} ${r.result}`);
  process.exit(results.every((r) => r.fits) ? 0 : 1);
}
