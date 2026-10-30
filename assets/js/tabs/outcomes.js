// Outcomes — the numbers this has to move (plan.derived.measures).
// The plan holds the commitment, never the measurement: real mode shows "not measured yet".

import { esc, fmtDay } from '../format.js';
import { card, detail, empty, grid, pageHead, sources, stateLabel, table, notFound } from '../ui.js';
import { requirementById, storyIdsFor, storyById, slug } from '../plan.js';

const BACK = { back: '#/outcomes', backLabel: 'Outcomes' };
const NOT_MEASURED = 'not measured yet';

function measures(m) {
  return m.plan.derived?.measures ?? [];
}

function latest(series) {
  const points = series?.points ?? [];
  return points.length ? points[points.length - 1] : null;
}

/** Small SVG trend line with a dashed target. Only ever drawn from a measurement series. */
function trendChart(series) {
  const points = series.points ?? [];
  if (points.length < 2) return '';
  const values = points.map((p) => p.value).concat(typeof series.target === 'number' ? [series.target] : []);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = (max - min) * 0.15 || 1;
  const lo = min - pad;
  const hi = max + pad;
  const W = 600;
  const H = 180;
  const x = (i) => 30 + (i / (points.length - 1)) * (W - 60);
  const y = (v) => H - 20 - ((v - lo) / (hi - lo)) * (H - 40);
  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const target = typeof series.target === 'number'
    ? `<line class="chart-target" x1="30" x2="${W - 30}" y1="${y(series.target).toFixed(1)}" y2="${y(series.target).toFixed(1)}"/>
       <text class="chart-label" x="${W - 30}" y="${(y(series.target) - 6).toFixed(1)}" text-anchor="end">target ${esc(series.target)} ${esc(series.unit ?? '')}</text>`
    : '';
  const dots = points.map((p, i) => `<circle class="chart-dot" cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="3.5"><title>${esc(p.on)}: ${esc(p.value)}</title></circle>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Trend toward target">
    ${target}<polyline class="chart-line" points="${line}"/>${dots}</svg>`;
}

function mainPage(m) {
  const list = measures(m);
  const cards = list.length
    ? list.map((ms) => {
      const series = m.measurements[ms.id];
      const last = latest(series);
      return card(m, {
        href: `#/outcomes/${slug(ms.id)}`,
        title: ms.id,
        value: last
          ? `<span class="card-value">${esc(last.value)} <span class="muted">${esc(series.unit ?? '')}</span></span>`
          : empty(NOT_MEASURED),
        note: `${esc(ms.statement)}${series?.target !== undefined ? ` Target: ${esc(series.target)} ${esc(series.unit ?? '')}.` : ''}`,
      });
    })
    : [card(m, {
      href: '#/outcomes/about',
      title: 'No measures yet',
      value: empty('The plan has no measures'),
      note: 'Measures are the numbers you commit to moving. They appear here when the plan lists them.',
    })];
  return `${pageHead(m, 'Outcomes', 'The numbers this system has to move. The plan records the commitment; the value only exists once the running system measures it.')}
    ${grid(cards)}${sources(m)}`;
}

function aboutPage(m) {
  return detail(m, {
    ...BACK,
    title: 'No measures yet',
    body: `<div class="panel">
      <p>Each measure in <code>plan.derived.measures</code> becomes a card here, and each card shows how that number is calculated.</p>
      <p><strong>What has to happen first:</strong> the plan needs at least one requirement that is a measure — a number with a target.
      The current plan has none, so there is nothing to show. When the platform republishes the plan with measures, they appear here without any change to this page.</p>
      <p>Until the system you are building is running and recording, every card reads "${NOT_MEASURED}". That is correct, not unfinished.</p>
    </div>`,
    source: `${m.sources.plan} → derived.measures`,
  });
}

function measurePage(m, ms) {
  const req = requirementById(m.plan, ms.id);
  const series = m.measurements[ms.id];
  const storyRows = storyIdsFor(m, ms.id).map((id) => {
    const s = storyById(m, id);
    return `<tr><td><a href="#/project/${esc(id)}"><code>${esc(id)}</code></a></td><td>${esc(s?.title ?? 'not in the plan')}</td><td>${stateLabel(s)}</td></tr>`;
  });
  const valueBlock = series
    ? `<p><strong>Latest:</strong> ${esc(latest(series)?.value)} ${esc(series.unit ?? '')} on ${esc(fmtDay(latest(series)?.on) ?? '')}
        ${series.target !== undefined ? ` · <strong>Target:</strong> ${esc(series.target)} ${esc(series.unit ?? '')}` : ''}</p>
       ${trendChart(series)}
       ${table(['Date', 'Value'], series.points.map((p) => `<tr><td>${esc(fmtDay(p.on) ?? p.on)}</td><td>${esc(p.value)}</td></tr>`), '')}`
    : `<p><strong>Value:</strong> ${NOT_MEASURED}.</p>
       <p class="muted">The project files hold what you promised to move, not how far it has moved. The value will come from the running system once it records this.</p>`;
  return detail(m, {
    ...BACK,
    title: ms.id,
    body: `
      <div class="panel"><p>${esc(ms.statement)}</p>${valueBlock}</div>
      <div class="panel"><h3>How it is calculated</h3>
        ${req ? `<p>From requirement <code>${esc(req.id)}</code> (${esc(req.kind ?? '')}, ${esc(req.priority ?? '')}): ${esc(req.statement)}</p>`
    : '<p class="muted">The requirement behind this measure is not in plan.requirements, so its calculation is not defined yet.</p>'}
        <p class="muted">The calculation is implemented by the stories that fulfil it, once they are built and verified:</p>
        ${table(['Story', 'Title', 'State'], storyRows, 'No story fulfils this measure yet.')}
      </div>`,
    source: `${m.sources.plan} → derived.measures, requirements; ${m.mode === 'sample' ? 'sample measurements' : 'no measurements exist yet'}`,
  });
}

export function render(m, sub = []) {
  if (!sub[0]) return mainPage(m);
  if (sub[0] === 'about') return aboutPage(m);
  const ms = measures(m).find((x) => slug(x.id) === sub[0]);
  return ms ? measurePage(m, ms) : notFound(m, BACK.back, BACK.backLabel, 'measure with that id');
}
