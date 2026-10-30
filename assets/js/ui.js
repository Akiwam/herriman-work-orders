// Rendering helpers shared by every tab. All return HTML strings; all data is escaped.

import { esc } from './format.js';

export const NOT_CHECKED = 'not checked yet';

export const STATE_LABELS = {
  not_started: 'Not started',
  in_progress: 'In progress',
  submitted: 'Submitted',
  verified: 'Verified',
};

export function hasNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

export function sampleBadge(m) {
  return m.mode === 'sample' ? '<span class="badge badge-sample">Sample</span>' : '';
}

export function empty(text) {
  return `<span class="card-value is-empty">${esc(text)}</span>`;
}

export function count(a, b) {
  return `<span class="card-value">${esc(a)} <span class="muted">of</span> ${esc(b)}</span>`;
}

/** Verification state of a story, or "not checked yet" when no verification has run. */
export function stateLabel(story) {
  if (!story?.state) return `<span class="state">${NOT_CHECKED}</span>`;
  const label = STATE_LABELS[story.state] ?? story.state;
  return `<span class="state state-${esc(story.state)}">${esc(label)}</span>`;
}

export function card(m, { href, title, value, note, warn }) {
  return `
    <a class="card${warn ? ' card-warn' : ''}" href="${href}">
      <div class="card-head"><h3>${esc(title)}</h3>${sampleBadge(m)}</div>
      <div class="card-value-wrap">${value}</div>
      ${note ? `<p class="card-note">${note}</p>` : ''}
      <span class="card-more">Details →</span>
    </a>`;
}

/** Top of a tab's main page. */
export function pageHead(m, title, intro) {
  return `
    <section class="hero">
      <h1>${esc(title)} ${sampleBadge(m)}</h1>
      ${intro ? `<p>${intro}</p>` : ''}
    </section>`;
}

/** A detail page, one level below a card. */
export function detail(m, { back, backLabel, title, body, source }) {
  return `
    <a class="back" href="${back}">← ${esc(backLabel)}</a>
    <div class="detail-head"><h2>${esc(title)}</h2>${sampleBadge(m)}</div>
    ${body}
    ${source ? `<p class="source">Source: ${esc(source)}</p>` : ''}`;
}

export function notFound(m, back, backLabel, what) {
  return detail(m, { back, backLabel, title: 'Not found', body: `<div class="panel"><p>There is no ${esc(what)} here.</p></div>` });
}

export function factRow(label, value) {
  const shown = value === null || value === undefined || value === ''
    ? '<span class="muted">not set in the plan</span>' : value;
  return `<dt>${esc(label)}</dt><dd>${shown}</dd>`;
}

export function table(headers, rows, emptyText) {
  if (!rows.length) return `<p class="muted">${esc(emptyText)}</p>`;
  return `<div class="table-wrap"><table>
    <thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.join('')}</tbody></table></div>`;
}

export function grid(cards) {
  return `<div class="grid">${cards.join('')}</div>`;
}

export function sources(m, ...extra) {
  return `<p class="source">Sources: ${[m.sources.plan, m.sources.progress, ...extra].map(esc).join(', ')}.</p>`;
}
