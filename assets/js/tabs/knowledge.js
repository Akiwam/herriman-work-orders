// Knowledge base — requirements, stories, traceability, and the project's own notes and decisions.
// Notes live in knowledge/notes.json, a file you own and add to; the platform never writes it.

import { esc, fmtDay } from '../format.js';
import { card, detail, grid, pageHead, sources, stateLabel, table, notFound, empty } from '../ui.js';
import { requirements, requirementById, storyIdsFor, storyById, enforcement, referencedRequirementIds } from '../plan.js';
import { answer } from '../chat.js';

const BACK = { back: '#/knowledge', backLabel: 'Knowledge base' };

const COVER = {
  kept: 'Verified',
  not_kept: 'Not verified yet',
  no_story: 'Gap — no story covers it',
};

function notes(m) {
  return Array.isArray(m.notes?.entries) ? m.notes.entries : [];
}

/** One row per requirement: from plan.requirements, or — when that list is empty — every id the stories reference. */
export function traceRows(m) {
  const reqs = requirements(m.plan);
  const ids = reqs.length ? reqs.map((r) => r.id) : referencedRequirementIds(m);
  return ids.map((id) => {
    const req = requirementById(m.plan, id);
    const e = enforcement(m, id);
    return { id, req, storyIds: storyIdsFor(m, id), status: e.status };
  });
}

function traceTable(m) {
  const rows = traceRows(m).map((r) => `
    <tr${r.status === 'no_story' && r.req?.priority === 'must' ? ' class="row-gap"' : ''}>
      <td><a href="#/knowledge/req/${encodeURIComponent(r.id)}"><code>${esc(r.id)}</code></a></td>
      <td>${r.req ? esc(r.req.statement) : '<span class="muted">statement not in the plan</span>'}</td>
      <td>${r.req ? `${esc(r.req.kind ?? '')} · ${esc(r.req.priority ?? '')}` : '<span class="muted">—</span>'}</td>
      <td>${r.storyIds.length ? r.storyIds.map((id) => `<a href="#/project/${esc(id)}">${esc(id)}</a>`).join(', ') : '<span class="muted">none</span>'}</td>
      <td>${esc(COVER[r.status])}</td>
    </tr>`);
  const reqsEmpty = requirements(m.plan).length === 0;
  return `
    ${reqsEmpty ? `<p class="notice">The plan's requirements list is empty, so these rows are the requirement ids your stories point at.
      Their statements will appear when the platform republishes the plan.</p>` : ''}
    ${table(['Requirement', 'Statement', 'Kind', 'Covered by', 'Status'], rows, 'No requirements in the plan, and no story references one.')}`;
}

function chatPanel() {
  return `
    <div class="panel chat" id="kb-chat">
      <h3>Ask about this project</h3>
      <p class="muted">Answers come only from this page's data, with the tab they came from. If the files do not say, it tells you.</p>
      <ol class="chat-log" aria-live="polite"></ol>
      <form class="chat-form">
        <label class="visually-hidden" for="kb-q">Question</label>
        <input id="kb-q" name="q" type="text" autocomplete="off" placeholder="e.g. When is STORY-nnn due?  ·  What guardrails are there?">
        <button type="submit">Ask</button>
      </form>
    </div>`;
}

function mainPage(m) {
  const trace = traceRows(m);
  const gaps = trace.filter((r) => r.status === 'no_story').length;
  const ns = notes(m);
  const cards = [
    card(m, {
      href: '#/knowledge/requirements',
      title: 'Requirements',
      value: requirements(m.plan).length
        ? `<span class="card-value">${requirements(m.plan).length}</span>`
        : empty('None in the plan yet'),
      note: `${trace.length} traced to stories${gaps ? `, ${gaps} with no story` : ''}.`,
      warn: requirements(m.plan).length === 0 || gaps > 0,
    }),
    card(m, {
      href: '#/knowledge/stories',
      title: 'Stories',
      value: `<span class="card-value">${m.stories.length}</span>`,
      note: 'Every story in the plan, with its narrative and state.',
    }),
    card(m, {
      href: '#/knowledge/notes',
      title: 'Decisions & notes',
      value: ns.length ? `<span class="card-value">${ns.length}</span>` : empty('No notes yet'),
      note: 'Added to knowledge/notes.json as the project goes.',
    }),
  ];
  return `${pageHead(m, 'Knowledge base', 'Everything the project knows about itself. It grows for the whole programme: add notes to knowledge/notes.json.')}
    ${chatPanel()}
    ${grid(cards)}
    <div class="panel"><h3>Traceability</h3>${traceTable(m)}</div>
    ${sources(m, m.sources.notes)}`;
}

function requirementsPage(m) {
  return detail(m, { ...BACK, title: 'Requirements', body: `<div class="panel">${traceTable(m)}</div>`, source: `${m.sources.plan} → requirements, stories[].fulfills` });
}

function requirementPage(m, id) {
  const req = requirementById(m.plan, id);
  const ids = storyIdsFor(m, id);
  if (!req && !ids.length) return notFound(m, BACK.back, BACK.backLabel, 'requirement with that id');
  const rows = ids.map((sid) => {
    const s = storyById(m, sid);
    return `<tr><td><a href="#/project/${esc(sid)}"><code>${esc(sid)}</code></a></td><td>${esc(s?.title ?? 'not in the plan')}</td><td>${stateLabel(s)}</td></tr>`;
  });
  return detail(m, {
    ...BACK,
    title: id,
    body: `
      <div class="panel">${req
    ? `<p>${esc(req.statement)}</p><p class="muted">${esc(req.kind ?? '')} · ${esc(req.priority ?? '')} · cluster: ${esc(req.cluster ?? '—')}</p>`
    : '<p class="muted">This requirement is referenced by stories, but its statement is not in the plan\'s requirements list yet.</p>'}
        <p><strong>${esc(COVER[enforcement(m, id).status])}</strong></p></div>
      <div class="panel"><h3>Covered by</h3>${table(['Story', 'Title', 'State'], rows, 'No story covers this requirement.')}</div>`,
    source: `${m.sources.plan} → requirements, stories[].fulfills`,
  });
}

function storiesPage(m) {
  const items = m.stories.map((s) => `
    <div class="panel">
      <h3><a href="#/project/${esc(s.id)}"><code>${esc(s.id)}</code></a> ${esc(s.title ?? '')} ${stateLabel(s)}</h3>
      <p>${s.narrative ? esc(s.narrative) : '<span class="muted">No narrative.</span>'}</p>
      <p class="muted">Release ${esc(s.release ?? '—')} · fulfils ${esc((s.fulfills ?? []).join(', ') || 'nothing')}</p>
    </div>`).join('');
  return detail(m, { ...BACK, title: 'Stories', body: items || '<p class="muted">No stories in the plan yet.</p>', source: `${m.sources.plan} → stories` });
}

function notesPage(m) {
  const ns = notes(m);
  const items = ns.map((n) => `
    <div class="panel">
      <h3>${esc(n.title)} <span class="badge">${esc(n.kind ?? 'note')}</span></h3>
      <p>${esc(n.body ?? '')}</p>
      <p class="muted">${esc(fmtDay(n.date) ?? n.date ?? '')}${n.evidence ? ` · evidence: <code>${esc(n.evidence)}</code>` : ''}</p>
    </div>`).join('');
  return detail(m, {
    ...BACK,
    title: 'Decisions & notes',
    body: items || `<div class="panel"><p class="muted">No notes yet. Add entries to <code>${esc(m.sources.notes)}</code>.</p></div>`,
    source: m.sources.notes,
  });
}

export function render(m, sub = []) {
  if (!sub[0]) return mainPage(m);
  if (sub[0] === 'requirements') return requirementsPage(m);
  if (sub[0] === 'stories') return storiesPage(m);
  if (sub[0] === 'notes') return notesPage(m);
  if (sub[0] === 'req' && sub[1]) return requirementPage(m, sub[1]);
  return notFound(m, BACK.back, BACK.backLabel, 'page');
}

/** Wire up the chat panel after the page is in the DOM. */
export function mount(root, m) {
  const box = root.querySelector('#kb-chat');
  if (!box) return;
  const log = box.querySelector('.chat-log');
  const form = box.querySelector('.chat-form');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const q = form.elements.q.value.trim();
    if (!q) return;
    const a = answer(q, m);
    const li = document.createElement('li');
    li.innerHTML = `<p class="chat-q">${esc(q)}</p><p class="chat-a">${esc(a.text)}</p>`
      + `<p class="chat-cite">${a.tab ? `From: ${esc(a.tab)} tab${m.mode === 'sample' ? ' · SAMPLE data' : ''}` : 'Not in the project files'}</p>`;
    log.appendChild(li);
    form.reset();
  });
}
