import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildModel } from '../assets/js/data.js';
import { freshness, esc } from '../assets/js/format.js';
import { render, DETAIL_IDS, planChecks } from '../assets/js/tabs/overview.js';

const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));

const realFiles = () => ({
  plan: read('.colaberry/plan.json'),
  progress: read('.colaberry/progress.json'),
  manifest: read('.colaberry/manifest.json'),
});
const sources = { plan: '.colaberry/plan.json', progress: '.colaberry/progress.json', manifest: '.colaberry/manifest.json' };
const NOW = Date.parse('2026-10-30T12:00:00Z');

function realModel(overrides = {}) {
  return buildModel({ mode: 'real', ...realFiles(), sources, now: NOW, ...overrides });
}

test('joins plan and progress on story id; state comes only from verification', () => {
  const m = realModel();
  assert.equal(m.stories.length, m.plan.stories.length);
  const s0 = m.stories.find((s) => s.id === 'STORY-000');
  assert.ok(s0.progress, 'STORY-000 has a progress entry');
  assert.equal(s0.state, s0.progress.verification?.state ?? null);

  const files = realFiles();
  files.progress.stories = files.progress.stories.map(({ verification, ...rest }) => rest);
  const unchecked = buildModel({ ...files, sources, now: NOW });
  assert.ok(unchecked.stories.every((s) => s.state === null), 'no verification block means no state');
  assert.match(render(unchecked, ['stories']), /not checked yet/);
});

test('overview headline counts come from progress.totals, not from counting stories', () => {
  const files = realFiles();
  files.progress.totals = { ...files.progress.totals, stories_verified: 7, stories_total: 99 };
  const html = render(buildModel({ ...files, sources, now: NOW }), []);
  assert.match(html, /7 <span class="muted">of<\/span> 99/);
});

test('missing totals render "not checked yet", never a zero', () => {
  const files = realFiles();
  delete files.progress.totals;
  const html = render(buildModel({ ...files, sources, now: NOW }), []);
  assert.match(html, /not checked yet/);
  assert.doesNotMatch(html, /card-value">0 /);
});

test('blank project name shows an honest empty state, with no hard-coded name', () => {
  const html = render(realModel(), []);
  assert.match(html, /Project name not set in the plan yet/);
  assert.doesNotMatch(html, /Herriman/);
});

test('every overview card drills down to a detail page that renders', () => {
  const m = realModel();
  const html = render(m, []);
  const links = [...html.matchAll(/class="card[^"]*" href="#\/overview\/([^"]+)"/g)].map((x) => x[1]);
  assert.ok(links.length >= 6, `expected at least 6 cards, got ${links.length}`);
  for (const id of links) {
    assert.ok(DETAIL_IDS.includes(id), `card links to unknown page ${id}`);
    const page = render(m, [id]);
    assert.match(page, /← Overview/);
    assert.match(page, /Source:/);
  }
});

test('deleting a story from the plan removes it from the page', () => {
  const files = realFiles();
  const before = render(buildModel({ ...files, sources, now: NOW }), ['stories']);
  assert.match(before, /STORY-013/);
  files.plan.stories = files.plan.stories.filter((s) => s.id !== 'STORY-013');
  const after = render(buildModel({ ...files, sources, now: NOW }), ['stories']);
  assert.doesNotMatch(after, /STORY-013/);
});

test('systems are grey and "not checked from here" in real mode, even when named', () => {
  const files = realFiles();
  files.plan.derived = { ...files.plan.derived, systems: ['API'] };
  const m = buildModel({ ...files, sources, now: NOW });
  const html = render(m, ['live']) + render(m, []);
  assert.match(html, /1 <span class="muted">not checked<\/span>/);
  assert.doesNotMatch(html, /dot-connected/);
});

test('sample mode labels every card and detail page as sample', () => {
  const m = buildModel({
    mode: 'sample',
    plan: read('assets/sample/plan.json'),
    progress: read('assets/sample/progress.json'),
    manifest: read('.colaberry/manifest.json'),
    sources,
    now: NOW,
  });
  const html = render(m, []);
  const cards = html.match(/class="card[ "]/g) ?? [];
  const badges = html.match(/badge-sample/g) ?? [];
  assert.ok(badges.length > cards.length, 'one badge per card plus the page heading');
  for (const id of DETAIL_IDS) assert.match(render(m, [id]), /badge-sample/);
});

test('plan check reports the gaps in the plan file', () => {
  const checks = planChecks(realModel());
  if (realFiles().plan.requirements.length === 0) {
    assert.ok(checks.some((c) => /no requirements/.test(c)));
  }
});

test('data age: plain under a week, a warning with sync prompt over a week', () => {
  const at = '2026-10-30T02:00:00Z';
  const fresh = freshness(at, Date.parse('2026-10-30T05:00:00Z'));
  assert.equal(fresh.level, 'fresh');
  assert.match(fresh.text, /^Data as of \d{1,2} \w+ 2026.* \(3 hours ago\)$/);
  const stale = freshness(at, Date.parse('2026-11-08T02:00:00Z'));
  assert.equal(stale.level, 'stale');
  assert.match(stale.text, /9 days ago\) — over a week old\. Sync from the portal to refresh\./);
  assert.equal(freshness(undefined).level, 'unknown');
});

test('plan text is escaped before it reaches the page', () => {
  assert.equal(esc('<script>"x"</script>'), '&lt;script&gt;&quot;x&quot;&lt;/script&gt;');
  const files = realFiles();
  files.plan.project = { ...files.plan.project, name: '<img src=x onerror=alert(1)>' };
  assert.doesNotMatch(render(buildModel({ ...files, sources, now: NOW }), []), /<img src=x/);
});
