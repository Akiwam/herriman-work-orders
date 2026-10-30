// Data model — the proposed tables behind the system, from knowledge/data-model.json.
// It is a proposal for review: nothing here has been created. Each table cites the
// requirement ids that call for it, looked up live in the plan.

import { esc } from '../format.js';
import { card, detail, grid, pageHead, table, notFound, empty } from '../ui.js';
import { requirementById, storyIdsFor, slug } from '../plan.js';

const BACK = { back: '#/data-model', backLabel: 'Data model' };

function entities(m) {
  return Array.isArray(m.dataModel?.entities) ? m.dataModel.entities : [];
}

function reqRef(m, id) {
  const req = requirementById(m.plan, id);
  const stories = storyIdsFor(m, id);
  const text = req ? esc(req.statement)
    : `<span class="muted">statement not in the plan${stories.length ? ` — referenced by ${esc(stories.join(', '))}` : ''}</span>`;
  return `<li><a href="#/knowledge/req/${encodeURIComponent(id)}"><code>${esc(id)}</code></a> ${text}</li>`;
}

function status(m) {
  return `<div class="notice"><strong>${esc(m.dataModel?.status ?? 'Proposed')}.</strong> ${esc(m.dataModel?.note ?? '')}</div>`;
}

function mainPage(m) {
  const list = entities(m);
  if (!list.length) {
    return `${pageHead(m, 'Data model', '')}
      ${grid([card(m, { href: '#/data-model/about', title: 'No data model yet', value: empty('Not written yet'), note: '' })])}`;
  }
  const cards = list.map((e) => card(m, {
    href: `#/data-model/${slug(e.name)}`,
    title: e.name,
    value: `<span class="card-value-text">${esc(e.purpose)}</span>`,
    note: `${(e.fields ?? []).length} fields · ${(e.relationships ?? []).length} relationships · from ${esc((e.requirements ?? []).join(', ') || '—')}`,
  }));
  const rels = list.flatMap((e) => (e.relationships ?? []).map((r) => `<tr><td><code>${esc(e.name)}</code></td><td>${esc(r.type)}</td><td><code>${esc(r.to)}</code></td><td>${esc(r.via ?? '')}</td></tr>`));
  return `${pageHead(m, 'Data model', 'The tables the system will need, derived from the requirements. Named for what is stored, never for a vendor.')}
    ${status(m)}
    ${grid(cards)}
    <div class="panel"><h3>Relationships</h3>${table(['Table', 'Relationship', 'To', 'Via'], rels, 'No relationships.')}</div>
    <p class="source">Sources: ${esc(m.sources.dataModel)}; requirement statements from ${esc(m.sources.plan)}.</p>`;
}

function entityPage(m, e) {
  const fields = (e.fields ?? []).map((f) => `<tr><td><code>${esc(f.name)}</code></td><td>${esc(f.type)}</td><td>${esc(f.note ?? '')}</td></tr>`);
  const rels = (e.relationships ?? []).map((r) => `<tr><td>${esc(r.type)}</td><td><a href="#/data-model/${slug(r.to)}"><code>${esc(r.to)}</code></a></td><td>${esc(r.via ?? '')}</td></tr>`);
  return detail(m, {
    ...BACK,
    title: e.name,
    body: `
      ${status(m)}
      <div class="panel"><p>${esc(e.purpose)}</p></div>
      <div class="panel"><h3>Fields</h3>${table(['Field', 'Type', 'Note'], fields, 'No fields.')}</div>
      <div class="panel"><h3>Relationships</h3>${table(['Relationship', 'To', 'Via'], rels, 'No relationships.')}</div>
      <div class="panel"><h3>Why it exists</h3><ul class="checks">${(e.requirements ?? []).map((id) => reqRef(m, id)).join('') || '<li class="muted">No requirement cited.</li>'}</ul></div>`,
    source: `${m.sources.dataModel}; ${m.sources.plan}`,
  });
}

export function render(m, sub = []) {
  if (!sub[0]) return mainPage(m);
  if (sub[0] === 'about') {
    return detail(m, { ...BACK, title: 'No data model yet', body: '<div class="panel"><p>The proposed tables go in <code>knowledge/data-model.json</code>.</p></div>' });
  }
  const e = entities(m).find((x) => slug(x.name) === sub[0]);
  return e ? entityPage(m, e) : notFound(m, BACK.back, BACK.backLabel, 'table with that name');
}
