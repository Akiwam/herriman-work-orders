// Users and use case — the roles the stories are written for (plan.derived.roles).

import { esc } from '../format.js';
import { card, detail, empty, grid, pageHead, sources, stateLabel, notFound } from '../ui.js';
import { slug } from '../plan.js';

const BACK = { back: '#/users', backLabel: 'Users & use case' };

function roles(m) {
  return m.plan.derived?.roles ?? [];
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/_/g, ' ').trim();

/** Stories written "As a <role>, …", or owned by that role. */
export function storiesForRole(m, role) {
  const r = norm(role);
  return m.stories.filter((s) => {
    const n = norm(s.narrative);
    return n.startsWith(`as a ${r},`) || n.startsWith(`as an ${r},`)
      || n.includes(`as a ${r} `) || n.includes(`as an ${r} `) || norm(s.owner_agent) === r;
  });
}

function mainPage(m) {
  const list = roles(m);
  const cards = list.length
    ? list.map((role) => {
      const stories = storiesForRole(m, role);
      const first = stories.find((s) => s.narrative);
      return card(m, {
        href: `#/users/${slug(role)}`,
        title: role.replace(/^\w/, (c) => c.toUpperCase()),
        value: `<span class="card-value">${stories.length} <span class="muted">stor${stories.length === 1 ? 'y' : 'ies'}</span></span>`,
        note: first ? esc(first.narrative) : 'No story narrative mentions this role yet.',
      });
    })
    : [card(m, {
      href: '#/users/about',
      title: 'No roles yet',
      value: empty('The plan has no roles'),
      note: 'Roles are taken from your stories, which are written "As a <role>, I want …".',
    })];
  return `${pageHead(m, 'Users & use case', 'Who this is for and what each of them is trying to get done, taken from the stories.')}
    ${grid(cards)}${sources(m)}`;
}

function rolePage(m, role) {
  const stories = storiesForRole(m, role);
  const items = stories.map((s) => `
    <div class="panel">
      <h3><a href="#/project/${esc(s.id)}"><code>${esc(s.id)}</code></a> ${esc(s.title ?? '')} ${stateLabel(s)}</h3>
      <p>${s.narrative ? esc(s.narrative) : '<span class="muted">No narrative in the plan.</span>'}</p>
    </div>`).join('');
  return detail(m, {
    ...BACK,
    title: role.replace(/^\w/, (c) => c.toUpperCase()),
    body: items || '<div class="panel"><p class="muted">No story is written for this role yet.</p></div>',
    source: `${m.sources.plan} → derived.roles, stories[].narrative`,
  });
}

function aboutPage(m) {
  return detail(m, {
    ...BACK,
    title: 'No roles yet',
    body: `<div class="panel"><p>Each role in <code>plan.derived.roles</code> becomes a card here, with the stories written for it.</p>
      <p><strong>What has to happen first:</strong> stories written as "As a &lt;role&gt;, I want …" in the plan.</p></div>`,
    source: `${m.sources.plan} → derived.roles`,
  });
}

export function render(m, sub = []) {
  if (!sub[0]) return mainPage(m);
  if (sub[0] === 'about') return aboutPage(m);
  const role = roles(m).find((r) => slug(r) === sub[0]);
  return role ? rolePage(m, role) : notFound(m, BACK.back, BACK.backLabel, 'role with that name');
}
