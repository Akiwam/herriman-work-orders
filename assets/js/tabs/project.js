// Project management — releases on a timeline, and every task with its due date.
// Both dates are shown per story: due_on (now) and due_baseline_on (first given). The gap is slippage.

import { esc, fmtDay, parseDay } from '../format.js';
import { detail, pageHead, sources, stateLabel, table, notFound, factRow, sampleBadge } from '../ui.js';
import { releases, releaseByKey, storyById } from '../plan.js';

const BACK = { back: '#/project', backLabel: 'Project management' };
const DAY = 24 * 60 * 60 * 1000;

function daysBetween(a, b) {
  const da = parseDay(a);
  const db = parseDay(b);
  return da && db ? Math.round((db - da) / DAY) : null;
}

/** Slippage of the current due date against the date first given. */
export function slip(story) {
  const n = daysBetween(story.due_baseline_on, story.due_on);
  if (n === null) return '<span class="muted">—</span>';
  if (n === 0) return 'on baseline';
  return n > 0 ? `<strong>${n} day${n === 1 ? '' : 's'} later</strong>` : `${-n} day${n === -1 ? '' : 's'} earlier`;
}

function day(value) {
  return fmtDay(value) ? esc(fmtDay(value)) : '<span class="muted">no date</span>';
}

function gantt(m) {
  const all = releases(m.plan);
  const dated = all.filter((r) => parseDay(r.starts_on) && parseDay(r.ends_on));
  const undated = all.filter((r) => !(parseDay(r.starts_on) && parseDay(r.ends_on)));
  const demo = parseDay(m.plan.schedule?.demo_day);

  let chart = '<p class="muted">No release in the plan has both a start and an end date, so there is nothing to place on a timeline yet.</p>';
  if (dated.length) {
    const starts = dated.map((r) => parseDay(r.starts_on).getTime());
    const ends = dated.map((r) => parseDay(r.ends_on).getTime()).concat(demo ? [demo.getTime()] : []);
    const min = Math.min(...starts, ...(demo ? [demo.getTime()] : []));
    const max = Math.max(...ends);
    const span = Math.round((max - min) / DAY) + 1;
    const pct = (t) => ((Math.round((t - min) / DAY)) / span) * 100;
    const rows = dated.map((r) => {
      const s = parseDay(r.starts_on).getTime();
      const e = parseDay(r.ends_on).getTime();
      const left = pct(s);
      const width = Math.max(((Math.round((e - s) / DAY) + 1) / span) * 100, 1.5);
      return `<a class="gantt-row" href="#/project/release/${encodeURIComponent(r.key)}">
        <span class="gantt-label">${esc(r.key)} · ${esc(r.name ?? '')}</span>
        <span class="gantt-track"><span class="gantt-bar${r.is_demo_target ? ' is-demo' : ''}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%"
          title="${esc(fmtDay(r.starts_on))} → ${esc(fmtDay(r.ends_on))}"></span>
          ${demo ? `<span class="gantt-demo" style="left:${pct(demo.getTime()).toFixed(2)}%" title="Demo day ${esc(fmtDay(m.plan.schedule.demo_day))}"></span>` : ''}
        </span>
        <span class="gantt-dates">${esc(fmtDay(r.starts_on))} → ${esc(fmtDay(r.ends_on))}</span>
      </a>`;
    }).join('');
    chart = `<div class="gantt">${rows}</div>
      <p class="muted gantt-legend"><span class="gantt-key"></span> release
      ${demo ? `&nbsp; <span class="gantt-key is-demo-line"></span> demo day ${esc(fmtDay(m.plan.schedule.demo_day))}` : ''}</p>`;
  }

  const undatedList = undated.length ? `
    <details class="undated"><summary>${undated.length} release${undated.length === 1 ? '' : 's'} without dates</summary>
      <ul class="checks">${undated.map((r) => `<li><a href="#/project/release/${encodeURIComponent(r.key)}">${esc(r.name || r.key)}</a> — ${esc((r.story_ids ?? []).length)} stories</li>`).join('')}</ul>
    </details>` : '';
  return chart + undatedList;
}

function mainPage(m) {
  const rows = m.stories.map((s) => `
    <tr class="row-link">
      <td><a href="#/project/${esc(s.id)}"><code>${esc(s.id)}</code></a></td>
      <td><a href="#/project/${esc(s.id)}">${esc(s.title ?? '')}</a></td>
      <td>${esc(s.release ?? '')}</td>
      <td>${day(s.due_on)}</td>
      <td>${day(s.due_baseline_on)}</td>
      <td>${slip(s)}</td>
      <td>${stateLabel(s)}</td>
    </tr>`);
  const sched = m.plan.schedule;
  return `${pageHead(m, 'Project management', 'Releases on a timeline, and every task with its current due date next to the date it was first given.')}
    <div class="panel">
      <h3>Releases ${sampleBadge(m)}</h3>
      ${sched ? `<p class="muted">Build ${day(sched.build_start)} → ${day(sched.build_end)} · demo day ${day(sched.demo_day)}${sched.demo_release_key ? ` (demoing ${esc(sched.demo_release_key)})` : ''}</p>` : '<p class="muted">The plan has no schedule yet.</p>'}
      ${gantt(m)}
    </div>
    <div class="panel"><h3>Tasks</h3>
      ${table(['Story', 'Title', 'Release', 'Due now', 'Due first given', 'Slippage', 'State'], rows, 'No stories in the plan yet.')}
    </div>
    ${sources(m)}`;
}

function releasePage(m, r) {
  const rows = (r.story_ids ?? []).map((id) => {
    const s = storyById(m, id);
    return `<tr><td><a href="#/project/${esc(id)}"><code>${esc(id)}</code></a></td><td>${esc(s?.title ?? 'not in the plan')}</td>
      <td>${s ? day(s.due_on) : ''}</td><td>${s ? stateLabel(s) : ''}</td></tr>`;
  });
  return detail(m, {
    ...BACK,
    title: r.name || r.key,
    body: `
      <div class="panel"><dl class="facts">
        ${factRow('Key', `<code>${esc(r.key)}</code>`)}
        ${factRow('Starts', fmtDay(r.starts_on) ? esc(fmtDay(r.starts_on)) : null)}
        ${factRow('Ends', fmtDay(r.ends_on) ? esc(fmtDay(r.ends_on)) : null)}
        ${factRow('Goal', r.goal ? esc(r.goal) : null)}
        ${factRow('Demo', r.demo ? esc(r.demo) : null)}
        ${factRow('Demo target', r.is_demo_target ? 'Yes' : 'No')}
      </dl></div>
      <div class="panel"><h3>Stories</h3>${table(['Story', 'Title', 'Due now', 'State'], rows, 'This release has no stories in the plan.')}</div>`,
    source: `${m.sources.plan} → releases`,
  });
}

function storyPage(m, s) {
  const crit = s.progress?.criteria ?? [];
  const v = s.verification;
  const release = releaseByKey(m.plan, s.release);
  return detail(m, {
    ...BACK,
    title: `${s.id} · ${s.title ?? ''}`,
    body: `
      <div class="panel">
        ${s.narrative ? `<p>${esc(s.narrative)}</p>` : ''}
        <dl class="facts">
          ${factRow('Release', release ? `<a href="#/project/release/${encodeURIComponent(release.key)}">${esc(release.name || release.key)}</a>` : (s.release ? esc(s.release) : null))}
          ${factRow('Owner', s.owner_agent ? esc(s.owner_agent) : null)}
          ${factRow('Due now', fmtDay(s.due_on) ? esc(fmtDay(s.due_on)) : null)}
          ${factRow('Due first given', fmtDay(s.due_baseline_on) ? esc(fmtDay(s.due_baseline_on)) : null)}
          ${factRow('Slippage', slip(s))}
          ${factRow('Fulfils', (s.fulfills ?? []).length ? s.fulfills.map((id) => `<a href="#/knowledge/req/${encodeURIComponent(id)}"><code>${esc(id)}</code></a>`).join(' ') : null)}
          ${factRow('Blocked by', (s.blocked_by ?? []).length ? s.blocked_by.map(esc).join(', ') : 'nothing')}
        </dl>
      </div>
      <div class="panel"><h3>Verification</h3>
        <dl class="facts">
          ${factRow('State', stateLabel(s))}
          ${v ? factRow('Criteria (platform)', `${esc(v.criteria_passed ?? 0)} of ${esc(v.criteria_total ?? crit.length)}`) : ''}
          ${v ? factRow('Commit', v.commit_url ? `<a href="${esc(v.commit_url)}">${esc(String(v.commit_sha ?? '').slice(0, 7))}</a>` : null) : ''}
          ${v ? factRow('Verified at', v.verified_at ? esc(new Date(v.verified_at).toLocaleString('en-GB')) : null) : ''}
        </dl>
      </div>
      <div class="panel"><h3>Acceptance criteria</h3>
        <ul class="checks">${(crit.length ? crit : (s.acceptance ?? []).map((text) => ({ text, passed: false })))
    .map((c) => `<li>${c.passed === true ? '☑' : '☐'} ${esc(c.text)}</li>`).join('') || '<li class="muted">None in the plan.</li>'}</ul>
        <p class="muted">☑ = ticked in progress.json (a claim until the platform verifies it).</p>
      </div>
      ${(s.failure_paths ?? []).length ? `<div class="panel"><h3>Failure paths</h3><ul class="checks">${s.failure_paths.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>` : ''}
      ${s.task_guidance ? `<details class="panel"><summary>Task guidance (the build brief for this story)</summary><pre class="guidance">${esc(s.task_guidance)}</pre></details>` : ''}`,
    source: `${m.sources.plan} → stories; ${m.sources.progress} → stories[].criteria, verification`,
  });
}

export function render(m, sub = []) {
  if (!sub[0]) return mainPage(m);
  if (sub[0] === 'release') {
    const r = releaseByKey(m.plan, sub[1]);
    return r ? releasePage(m, r) : notFound(m, BACK.back, BACK.backLabel, 'release with that key');
  }
  const s = storyById(m, sub[0]);
  return s ? storyPage(m, s) : notFound(m, BACK.back, BACK.backLabel, 'story with that id');
}
