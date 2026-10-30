import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildModel } from '../assets/js/data.js';
import { answer } from '../assets/js/chat.js';
import * as overview from '../assets/js/tabs/overview.js';
import * as outcomes from '../assets/js/tabs/outcomes.js';
import * as users from '../assets/js/tabs/users.js';
import * as guardrails from '../assets/js/tabs/guardrails.js';
import * as systems from '../assets/js/tabs/systems.js';
import * as project from '../assets/js/tabs/project.js';
import * as agents from '../assets/js/tabs/agents.js';
import * as knowledge from '../assets/js/tabs/knowledge.js';
import * as datamodel from '../assets/js/tabs/datamodel.js';

const TABS = {
  overview, outcomes, users, guardrails, systems, project, agents, knowledge, 'data-model': datamodel,
};

const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
const NOW = Date.parse('2026-10-30T12:00:00Z');
const sources = {
  plan: '.colaberry/plan.json', progress: '.colaberry/progress.json', manifest: '.colaberry/manifest.json',
  notes: 'knowledge/notes.json', dataModel: 'knowledge/data-model.json',
};

function files(mode = 'real') {
  return mode === 'sample'
    ? { plan: read('assets/sample/plan.json'), progress: read('assets/sample/progress.json'), notes: read('assets/sample/notes.json') }
    : { plan: read('.colaberry/plan.json'), progress: read('.colaberry/progress.json'), notes: read('knowledge/notes.json') };
}

function model(mode = 'real', edit = (f) => f) {
  const f = edit(files(mode));
  return buildModel({
    mode, ...f, manifest: read('.colaberry/manifest.json'), dataModel: read('knowledge/data-model.json'), sources, now: NOW,
  });
}

function route(href) {
  const parts = href.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  return { tab: TABS[parts[0]], sub: parts.slice(1) };
}

/** Every card link on a page. */
function cardLinks(html) {
  return [...html.matchAll(/<a class="(?:card|gantt-row)[^"]*" href="([^"]+)"/g)].map((x) => x[1]);
}

/** Every rendered page in the Command Center: each tab plus everything one level below a card. */
function allPages(m) {
  const pages = [];
  for (const [id, tab] of Object.entries(TABS)) {
    const html = tab.render(m, []);
    pages.push({ href: `#/${id}`, html });
    for (const href of cardLinks(html)) {
      const r = route(href);
      pages.push({ href, html: r.tab.render(m, r.sub), from: id, r });
    }
  }
  return pages;
}

for (const mode of ['real', 'sample']) {
  test(`${mode}: every tab renders, has at least one card, and every card drills to a real page`, () => {
    const m = model(mode);
    for (const [id, tab] of Object.entries(TABS)) {
      const html = tab.render(m, []);
      assert.ok(cardLinks(html).length > 0, `${id} has no cards`);
    }
    for (const p of allPages(m).filter((x) => x.from)) {
      assert.ok(p.r.tab, `${p.href} points at an unknown tab`);
      assert.match(p.html, /class="back"/, `${p.href} is not a detail page`);
      assert.doesNotMatch(p.html, /<h2>Not found<\/h2>/, `${p.href} is a dead end`);
    }
  });
}

test('sample: every page is labelled as sample', () => {
  for (const p of allPages(model('sample'))) assert.match(p.html, /badge-sample/, `${p.href} has no sample label`);
});

test('real: no page carries a sample label or sample text', () => {
  for (const p of allPages(model('real'))) {
    assert.doesNotMatch(p.html, /badge-sample/, p.href);
    assert.doesNotMatch(p.html, /Sample:/, p.href);
  }
});

test('real: no page shows a green connection, a success rate, or a measured value', () => {
  const m = model('real', (f) => {
    f.plan.derived = {
      ...f.plan.derived,
      systems: ['API'],
      measures: [{ id: 'REQ-053', statement: 'The software must be operational by July 1, 2027.' }],
      guardrails: [{ id: 'REQ-051', statement: 'Work orders can be created, updated and completed.' }],
    };
    return f;
  });
  for (const p of allPages(m)) {
    const visible = p.html.replace(/style="[^"]*"/g, ''); // layout percentages are not shown to the reader
    assert.doesNotMatch(visible, /dot-connected|dot-error/, `${p.href} shows a connection state`);
    assert.doesNotMatch(visible, /success rate|\d+%/i, `${p.href} shows a rate`);
  }
  assert.match(outcomes.render(m, []), /not measured yet/);
  assert.match(outcomes.render(m, ['req-053']), /not measured yet/);
  assert.match(systems.render(m, []), /Not checked from here/);
  assert.match(guardrails.render(m, []), /A promise you have made and not yet kept/);
});

test('empty plan sections still drill down to a page saying what is needed first', () => {
  const m = model('real');
  for (const [tab, re] of [[outcomes, /What has to happen first/], [guardrails, /What has to happen first/], [systems, /What has to happen first/]]) {
    if (!/about/.test(tab.render(m, []))) continue; // section is populated in this plan
    assert.match(tab.render(m, ['about']), re);
  }
});

test('agents: owners are labelled as owners, not AI agents, with no runs and no skills', () => {
  const m = model('real');
  if (m.plan.agents.length) return;
  const html = agents.render(m, []);
  assert.match(html, /These are story owners, not AI agents/);
  assert.match(html, /no skills registered yet/);
  assert.match(html, /no runs recorded/);
  for (const o of agents.owners(m)) assert.ok(o.owns.length > 0);
});

test('project: shows both due dates and the slippage between them', () => {
  const m = model('real', (f) => {
    f.plan.stories = f.plan.stories.map((s) => (s.id === 'STORY-003' ? { ...s, due_on: '2026-11-03', due_baseline_on: '2026-10-31' } : s));
    return f;
  });
  const html = project.render(m, []);
  assert.match(html, /Due first given/);
  assert.match(project.render(m, ['STORY-003']), /3 days later/);
});

test('deleting a story from the plan removes it from every tab', () => {
  const m = model('real', (f) => {
    f.plan.stories = f.plan.stories.filter((s) => s.id !== 'STORY-012');
    f.plan.releases = f.plan.releases.map((r) => ({ ...r, story_ids: (r.story_ids ?? []).filter((id) => id !== 'STORY-012') }));
    return f;
  });
  for (const p of allPages(m)) assert.doesNotMatch(p.html, /STORY-012/, `${p.href} still shows STORY-012`);
});

test('knowledge: traceability falls back to the ids stories reference, and flags a must with no story', () => {
  const m = model('real');
  const rows = knowledge.traceRows(m);
  if (!m.plan.requirements.length) {
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.storyIds.length > 0));
  }
  const withGap = model('real', (f) => {
    f.plan.requirements = [{ id: 'REQ-900', statement: 'Uncovered must.', kind: 'FUNC', priority: 'must', cluster: 'x', fulfilled_by: [] }];
    return f;
  });
  assert.match(knowledge.render(withGap, []), /row-gap/);
  assert.match(knowledge.render(withGap, []), /Gap — no story covers it/);
});

test('chat answers from the data, cites the tab, and refuses what is not in the files', () => {
  const m = model('real');
  const due = answer('When is STORY-003 due?', m);
  assert.equal(due.tab, 'Project management');
  assert.match(due.text, /STORY-003 is due/);
  const owner = answer('who owns story 11', m);
  assert.equal(owner.tab, 'AI agents');
  assert.match(answer('how many stories are verified', m).text, /of \d+ stories verified/);
  assert.match(answer('REQ-037', m).text, /REQ-037/);
  const no = answer('What is the weather in Herriman?', m);
  assert.equal(no.tab, null);
  assert.match(no.text, /cannot answer/);
});

test('data model: every table cites requirements and is proposed, not created', () => {
  const m = model('real');
  const html = datamodel.render(m, []);
  assert.match(html, /Proposed — not created yet/);
  for (const e of m.dataModel.entities) {
    assert.ok(e.requirements.length > 0, `${e.name} cites no requirement`);
    assert.doesNotMatch(e.name, /bluestakes|lama|sprypoint|madison|hellosign/i, `${e.name} is named after a vendor`);
  }
});
