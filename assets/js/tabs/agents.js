// AI agents — plan.agents[] when the plan has a scoped roster; otherwise the owners of each story,
// clearly labelled as owners rather than AI agents. No run history exists, so none is shown.

import { esc } from '../format.js';
import { card, detail, empty, grid, pageHead, sources, stateLabel, table, notFound, factRow } from '../ui.js';
import { storyById, slug } from '../plan.js';

const BACK = { back: '#/agents', backLabel: 'AI agents' };
const NO_RUNS = 'no runs recorded';
const NO_SKILLS = 'no skills registered yet';

function agents(m) {
  return Array.isArray(m.plan.agents) ? m.plan.agents : [];
}

/** Story owners grouped exactly as written in the plan (owner_agent). */
export function owners(m) {
  const map = new Map();
  for (const s of m.stories) {
    const name = (s.owner_agent ?? '').trim() || 'No owner set';
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(s.id);
  }
  return [...map].map(([name, ids]) => ({ name, owns: ids }));
}

function skillsList(skills) {
  return Array.isArray(skills) && skills.length
    ? skills.map((k) => `<span class="badge">${esc(typeof k === 'string' ? k : k.name ?? JSON.stringify(k))}</span>`).join(' ')
    : `<span class="muted">${NO_SKILLS}</span>`;
}

function list(items) {
  return Array.isArray(items) && items.length ? items.map(esc).join('; ') : null;
}

function ownedTable(m, ids) {
  const rows = (ids ?? []).map((id) => {
    const s = storyById(m, id);
    return `<tr><td><a href="#/project/${esc(id)}"><code>${esc(id)}</code></a></td><td>${esc(s?.title ?? 'not in the plan')}</td><td>${stateLabel(s)}</td></tr>`;
  });
  return table(['Story', 'Title', 'State'], rows, 'Owns no stories.');
}

function mainPage(m) {
  const roster = agents(m);
  if (roster.length) {
    const byAutonomy = m.plan.derived?.counts?.agents_by_autonomy ?? {};
    const breakdown = Object.entries(byAutonomy).map(([k, v]) => `${esc(v)} ${esc(k)}`).join(' · ');
    const cards = roster.map((a) => card(m, {
      href: `#/agents/agent/${slug(a.id ?? a.name)}`,
      title: a.name ?? a.id,
      value: `<span class="card-value-text">${esc(a.purpose ?? '')}</span>`,
      note: `Autonomy: ${esc(a.autonomy_level ?? '—')} · Runs: ${NO_RUNS}<br>Skills: ${skillsList(a.skills)}`,
    }));
    return `${pageHead(m, 'AI agents', `The agents designed for this system${breakdown ? ` — ${breakdown}` : ''}. Nothing has run yet.`)}
      ${grid(cards)}${sources(m)}`;
  }

  const groups = owners(m);
  const cards = groups.length
    ? groups.map((o) => card(m, {
      href: `#/agents/owner/${slug(o.name)}`,
      title: o.name,
      value: `<span class="card-value">${o.owns.length} <span class="muted">stor${o.owns.length === 1 ? 'y' : 'ies'}</span></span>`,
      note: `${o.owns.map(esc).join(', ')}<br>Skills: <span class="muted">${NO_SKILLS}</span> · Runs: <span class="muted">${NO_RUNS}</span>`,
    }))
    : [card(m, { href: '#/agents/about', title: 'No owners yet', value: empty('No stories in the plan'), note: '' })];
  return `${pageHead(m, 'AI agents', '')}
    <div class="notice">The plan does not carry a scoped agent roster yet, so this tab shows <strong>who owns each story</strong>.
    These are story owners, not AI agents — a job title is not an agent. Agents appear here once the plan defines them.</div>
    ${grid(cards)}${sources(m)}`;
}

function agentPage(m, a) {
  return detail(m, {
    ...BACK,
    title: a.name ?? a.id,
    body: `
      <div class="panel"><dl class="facts">
        ${factRow('Purpose', a.purpose ? esc(a.purpose) : null)}
        ${factRow('Trigger', a.trigger ? `${esc(a.trigger_type ?? '')} — ${esc(a.trigger)}` : null)}
        ${factRow('Inputs', list(a.inputs))}
        ${factRow('Outputs', list(a.outputs))}
        ${factRow('Autonomy', a.autonomy_level ? esc(a.autonomy_level) : null)}
        ${factRow('Approval gates', list(a.approval_gates))}
        ${factRow('Escalation rules', list(a.escalation_rules))}
        ${factRow('Skills', skillsList(a.skills))}
        ${factRow('Runs', `<span class="muted">${NO_RUNS}</span>`)}
      </dl></div>
      <div class="panel"><h3>Stories it owns</h3>${ownedTable(m, a.owns)}</div>`,
    source: `${m.sources.plan} → agents[]`,
  });
}

function ownerPage(m, o) {
  return detail(m, {
    ...BACK,
    title: o.name,
    body: `
      <div class="notice">A story owner from the plan, not a scoped AI agent. Skills: ${NO_SKILLS}. Runs: ${NO_RUNS}.</div>
      <div class="panel"><h3>Stories owned</h3>${ownedTable(m, o.owns)}</div>`,
    source: `${m.sources.plan} → stories[].owner_agent`,
  });
}

export function render(m, sub = []) {
  if (!sub[0]) return mainPage(m);
  if (sub[0] === 'agent') {
    const a = agents(m).find((x) => slug(x.id ?? x.name) === sub[1]);
    return a ? agentPage(m, a) : notFound(m, BACK.back, BACK.backLabel, 'agent with that id');
  }
  if (sub[0] === 'owner') {
    const o = owners(m).find((x) => slug(x.name) === sub[1]);
    return o ? ownerPage(m, o) : notFound(m, BACK.back, BACK.backLabel, 'owner with that name');
  }
  if (sub[0] === 'about') {
    return detail(m, { ...BACK, title: 'No owners yet', body: '<div class="panel"><p>Owners come from each story\'s owner in the plan. The plan has no stories yet.</p></div>' });
  }
  return notFound(m, BACK.back, BACK.backLabel, 'page');
}
