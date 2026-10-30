// Router, header and mode switch. Tabs render from the model that data.js builds.

import { loadModel, getMode, rememberMode } from './data.js';
import { esc, freshness } from './format.js';
import { projectName } from './plan.js';
import * as overview from './tabs/overview.js';
import * as outcomes from './tabs/outcomes.js';
import * as users from './tabs/users.js';
import * as guardrails from './tabs/guardrails.js';
import * as systems from './tabs/systems.js';
import * as project from './tabs/project.js';
import * as agents from './tabs/agents.js';
import * as knowledge from './tabs/knowledge.js';
import * as datamodel from './tabs/datamodel.js';

export const TABS = [
  { id: 'overview', label: 'Overview', view: overview },
  { id: 'outcomes', label: 'Outcomes', view: outcomes },
  { id: 'users', label: 'Users & use case', view: users },
  { id: 'guardrails', label: 'Guardrails', view: guardrails },
  { id: 'systems', label: 'Systems', view: systems },
  { id: 'project', label: 'Project management', view: project },
  { id: 'agents', label: 'AI agents', view: agents },
  { id: 'knowledge', label: 'Knowledge base', view: knowledge },
  { id: 'data-model', label: 'Data model', view: datamodel },
];

const el = {
  view: document.getElementById('view'),
  tabs: document.getElementById('tabs'),
  stamp: document.getElementById('stamp'),
  modeSwitch: document.getElementById('mode-switch'),
  ribbon: document.getElementById('sample-ribbon'),
  name: document.getElementById('project-name'),
};

let mode = getMode();
const models = {}; // one load per mode per page view

function parseRoute() {
  const parts = window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const tab = TABS.find((t) => t.id === parts[0]) ?? TABS[0];
  return { tab, sub: parts.slice(1) };
}

function renderTabs(active) {
  el.tabs.innerHTML = TABS.map((t) =>
    `<a href="#/${t.id}"${t.id === active.id ? ' aria-current="page"' : ''}>${esc(t.label)}</a>`).join('');
}

function renderModeSwitch() {
  el.modeSwitch.innerHTML = `
    <button type="button" class="real" aria-pressed="${mode === 'real'}" data-mode="real">Real</button>
    <button type="button" class="sample" aria-pressed="${mode === 'sample'}" data-mode="sample">Sample</button>`;
  el.ribbon.hidden = mode !== 'sample';
  document.body.classList.toggle('is-sample', mode === 'sample');
}

el.modeSwitch.addEventListener('click', (event) => {
  const next = event.target.closest('button')?.dataset.mode;
  if (!next || next === mode) return;
  mode = next;
  rememberMode(mode);
  render();
});

function renderStamp(manifest) {
  const f = freshness(manifest?.generated_at);
  el.stamp.className = `stamp is-${f.level}`;
  el.stamp.textContent = f.text;
  el.stamp.title = 'When the platform last changed these files — not when you last synced. '
    + 'An old date means either nothing has changed or you have not synced; sync from the portal either way.';
}

function renderName(m) {
  const name = projectName(m.plan);
  el.name.textContent = name || 'Project name not set in the plan';
  el.name.classList.toggle('is-missing', !name);
}

async function getModel() {
  if (!models[mode]) {
    models[mode] = loadModel(mode).catch((err) => {
      delete models[mode];
      throw err;
    });
  }
  return models[mode];
}

async function render() {
  const { tab, sub } = parseRoute();
  renderTabs(tab);
  renderModeSwitch();
  document.title = `${tab.label} · Command Center`;

  let m;
  try {
    m = await getModel();
  } catch (err) {
    console.error(err);
    el.stamp.className = 'stamp is-unknown';
    el.stamp.textContent = 'Data age unknown — the project files could not be read.';
    el.view.innerHTML = `
      <div class="panel">
        <h2>Could not read the project files</h2>
        <p>${esc(err.message)}</p>
        <p class="muted">This page reads <code>.colaberry/plan.json</code>, <code>.colaberry/progress.json</code> and
        <code>.colaberry/manifest.json</code> from the repo. Open it through a web server (GitHub Pages, or
        <code>python -m http.server</code> in the repo folder), not by double-clicking the file.</p>
      </div>`;
    return;
  }

  renderStamp(m.manifest);
  renderName(m);
  el.view.innerHTML = tab.view.render(m, sub);
  tab.view.mount?.(el.view, m);
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', render);
render();
