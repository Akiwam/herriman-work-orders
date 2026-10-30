// Guardrails — what must never happen (plan.derived.guardrails), and whether anything enforces it yet.

import { esc } from '../format.js';
import { card, detail, empty, grid, pageHead, sources, stateLabel, table, notFound } from '../ui.js';
import { enforcement, requirementById, storyById, slug } from '../plan.js';

const BACK = { back: '#/guardrails', backLabel: 'Guardrails' };

const VERDICT = {
  kept: 'Enforced — every story that fulfils it is verified.',
  not_kept: 'A promise you have made and not yet kept — its stories are not all verified.',
  no_story: 'A promise you have made and not yet kept — no story is written to enforce it.',
};

function guardrails(m) {
  return m.plan.derived?.guardrails ?? [];
}

function mainPage(m) {
  const list = guardrails(m);
  const cards = list.length
    ? list.map((g) => {
      const e = enforcement(m, g.id);
      return card(m, {
        href: `#/guardrails/${slug(g.id)}`,
        title: g.id,
        value: `<span class="card-value-text">${esc(g.statement)}</span>`,
        note: `<strong>${esc(VERDICT[e.status])}</strong>`,
        warn: e.status !== 'kept',
      });
    })
    : [card(m, {
      href: '#/guardrails/about',
      title: 'No guardrails yet',
      value: empty('The plan has no guardrails'),
      note: 'Guardrails are your SAFE requirements. The current plan has none, which is worth fixing before building further.',
      warn: true,
    })];
  return `${pageHead(m, 'Guardrails', 'The promises this system makes about what must never happen, and whether anything in the build enforces each one yet.')}
    ${grid(cards)}${sources(m)}`;
}

function guardrailPage(m, g) {
  const e = enforcement(m, g.id);
  const req = requirementById(m.plan, g.id);
  const rows = e.ids.map((id) => {
    const s = storyById(m, id);
    return `<tr><td><a href="#/project/${esc(id)}"><code>${esc(id)}</code></a></td><td>${esc(s?.title ?? 'not in the plan')}</td><td>${stateLabel(s)}</td></tr>`;
  });
  return detail(m, {
    ...BACK,
    title: g.id,
    body: `
      <div class="panel"><p>${esc(g.statement)}</p><p><strong>${esc(VERDICT[e.status])}</strong></p>
        ${req ? `<p class="muted">Requirement ${esc(req.kind ?? '')}, ${esc(req.priority ?? '')}, cluster: ${esc(req.cluster ?? '—')}.</p>` : ''}
      </div>
      <div class="panel"><h3>Stories that enforce it</h3>${table(['Story', 'Title', 'State'], rows, 'No story fulfils this guardrail yet.')}</div>`,
    source: `${m.sources.plan} → derived.guardrails, requirements[].fulfilled_by; ${m.sources.progress} → verification.state`,
  });
}

function aboutPage(m) {
  return detail(m, {
    ...BACK,
    title: 'No guardrails yet',
    body: `<div class="panel">
      <p>Each guardrail in <code>plan.derived.guardrails</code> becomes a card here, with whether the stories that enforce it are verified.</p>
      <p><strong>What has to happen first:</strong> the plan needs at least one SAFE requirement. The current plan has no requirements at all,
      so it has no guardrails either — this is worth fixing with the platform before building further. When the plan is republished, guardrails appear here on their own.</p>
    </div>`,
    source: `${m.sources.plan} → derived.guardrails`,
  });
}

export function render(m, sub = []) {
  if (!sub[0]) return mainPage(m);
  if (sub[0] === 'about') return aboutPage(m);
  const g = guardrails(m).find((x) => slug(x.id) === sub[0]);
  return g ? guardrailPage(m, g) : notFound(m, BACK.back, BACK.backLabel, 'guardrail with that id');
}
