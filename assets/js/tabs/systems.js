// Systems — what this connects to (plan.derived.systems).
// The plan only knows names. Whether a system is connected is a fact about the running system,
// so every indicator is grey and "not checked from here" until that system reports otherwise.

import { esc } from '../format.js';
import { card, detail, empty, grid, pageHead, sources, table, notFound } from '../ui.js';
import { requirements, slug } from '../plan.js';

const BACK = { back: '#/systems', backLabel: 'Systems' };
const STATUS_TEXT = { connected: 'Connected', not_connected: 'Not connected', error: 'Error' };

function systems(m) {
  return m.plan.derived?.systems ?? [];
}

export function statusOf(m, name) {
  const st = m.systemStatus[name];
  if (st && STATUS_TEXT[st.state]) {
    return { state: st.state, text: STATUS_TEXT[st.state], checkedAt: st.checked_at ? new Date(st.checked_at).toLocaleString('en-GB') : null };
  }
  return { state: null, text: 'Not checked from here', checkedAt: null };
}

function indicator(s) {
  return `<span class="dot${s.state ? ` dot-${esc(s.state)}` : ''}"></span>${esc(s.text)}`;
}

function mainPage(m) {
  const list = systems(m);
  const cards = list.length
    ? list.map((name) => {
      const s = statusOf(m, name);
      return card(m, {
        href: `#/systems/${slug(name)}`,
        title: name,
        value: `<span class="card-value-text">${indicator(s)}</span>`,
        note: `Last checked: ${s.checkedAt ? esc(s.checkedAt) : 'never'}`,
      });
    })
    : [card(m, {
      href: '#/systems/about',
      title: 'No systems yet',
      value: empty('The plan names no systems'),
      note: 'Systems come from your CONSTRAINT requirements. None are in the current plan.',
    })];
  return `${pageHead(m, 'Systems', 'What this connects to. Grey means unknown: this static page cannot reach any system, so nothing turns green until the running system reports it.')}
    ${grid(cards)}${sources(m)}`;
}

function systemPage(m, name) {
  const s = statusOf(m, name);
  const mentions = requirements(m.plan).filter((r) => String(r.statement ?? '').toLowerCase().includes(name.toLowerCase()));
  const rows = mentions.map((r) => `<tr><td><code>${esc(r.id)}</code></td><td>${esc(r.statement)}</td></tr>`);
  return detail(m, {
    ...BACK,
    title: name,
    body: `
      <div class="panel"><dl class="facts">
        <dt>Status</dt><dd>${indicator(s)}</dd>
        <dt>Last checked</dt><dd>${s.checkedAt ? esc(s.checkedAt) : 'never'}</dd>
      </dl>
      <p class="muted">${s.state ? 'Reported status.' : 'Nothing in this repo can check this connection. It will show a real status once the running system reports one.'}</p></div>
      <div class="panel"><h3>Requirements that name it</h3>${table(['Requirement', 'Statement'], rows, 'No requirement in the plan mentions this system by name.')}</div>`,
    source: `${m.sources.plan} → derived.systems${m.mode === 'sample' ? '; sample statuses' : ''}`,
  });
}

function aboutPage(m) {
  return detail(m, {
    ...BACK,
    title: 'No systems yet',
    body: `<div class="panel">
      <p>Each system in <code>plan.derived.systems</code> gets a row here with a status dot (connected / not connected / error) and a last-checked time.</p>
      <p><strong>What has to happen first:</strong> CONSTRAINT requirements in the plan that name the systems this connects to.
      The current plan has none. Even then, every dot stays grey until the running system reports its own connections.</p>
    </div>`,
    source: `${m.sources.plan} → derived.systems`,
  });
}

export function render(m, sub = []) {
  if (!sub[0]) return mainPage(m);
  if (sub[0] === 'about') return aboutPage(m);
  const name = systems(m).find((x) => slug(x) === sub[0]);
  return name ? systemPage(m, name) : notFound(m, BACK.back, BACK.backLabel, 'system with that name');
}
