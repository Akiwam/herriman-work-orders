// Overview — the thirty-second screen, plus one detail page behind every card.
// Everything shown is read from the model (plan.json + progress.json + manifest.json).

import { esc, fmtDay, daysFromToday, relDays } from '../format.js';
import {
  NOT_CHECKED, hasNumber, empty, count, card, detail, factRow, stateLabel, pageHead, grid, table,
} from '../ui.js';
import {
  projectName, projectDescriptor, releases, releaseByKey, releaseByDate, nextOpenRelease, releaseLabel, requirements,
} from '../plan.js';

export { projectName };

const BACK = { back: '#/overview', backLabel: 'Overview' };

/**
 * Facts about the plan file itself that a reader should know before trusting the page.
 * Each one is derived from the file; none is an opinion about the project.
 */
export function planChecks(m) {
  const { plan } = m;
  const checks = [];
  if (requirements(plan).length === 0) {
    checks.push('The plan contains no requirements, so nothing can be traced from a requirement to a story yet.');
  }
  if (!projectName(plan)) checks.push('The plan has no project name.');
  if (!plan.schedule) checks.push('The plan has no schedule (build start, build end, demo day).');

  const emptyReleases = releases(plan).filter((r) => !Array.isArray(r.story_ids) || r.story_ids.length === 0);
  if (emptyReleases.length > 0) {
    checks.push(`${emptyReleases.length} of ${releases(plan).length} releases have no stories in them `
      + `(${emptyReleases.map((r) => r.name || r.key).join('; ')}).`);
  }

  const movedEarlier = m.stories.filter((s) => s.due_on && s.due_baseline_on && s.due_on < s.due_baseline_on);
  if (movedEarlier.length > 0) {
    checks.push(`${movedEarlier.length} of ${m.stories.length} stories have a current due date earlier than `
      + 'the date they were first given — the current dates may not be the intended ones.');
  }

  const baselines = m.stories.map((s) => s.due_baseline_on).filter(Boolean).sort();
  const lastBaseline = baselines[baselines.length - 1];
  if (plan.schedule?.demo_day && lastBaseline && plan.schedule.demo_day < lastBaseline) {
    checks.push(`Demo day in the schedule (${fmtDay(plan.schedule.demo_day)}) is earlier than the latest `
      + `baseline story date (${fmtDay(lastBaseline)}).`);
  }

  const d = plan.derived ?? {};
  if (!(d.measures ?? []).length) checks.push('No measures (outcome numbers) are in the plan.');
  if (!(d.guardrails ?? []).length) checks.push('No guardrails (SAFE requirements) are in the plan.');
  if (!(d.systems ?? []).length) checks.push('No connected systems are named in the plan.');
  return checks;
}

/** "1 connected · 1 error · 1 not checked" — grey for anything the running system has not reported. */
export function liveSummary(m, systems) {
  const tally = { connected: 0, not_connected: 0, error: 0, unknown: 0 };
  for (const name of systems) {
    const state = m.systemStatus[name]?.state;
    tally[state in tally ? state : 'unknown'] += 1;
  }
  const parts = [
    ['connected', 'connected'], ['error', 'error'], ['not_connected', 'not connected'], ['unknown', 'not checked'],
  ].filter(([k]) => tally[k] > 0)
    .map(([k, label]) => `<span class="dot${k === 'unknown' ? '' : ` dot-${k}`}"></span>${tally[k]} <span class="muted">${label}</span>`);
  return `<span class="card-value">${parts.join(' &nbsp;')}</span>`;
}

// ---------- the Overview page ----------

function overviewPage(m) {
  const { plan, progress } = m;
  const name = projectName(plan);
  const descriptor = projectDescriptor(plan);
  const totals = progress.totals ?? null;
  const schedule = plan.schedule ?? null;
  const checks = planChecks(m);
  const systems = plan.derived?.systems ?? [];

  const byDate = releaseByDate(m);
  const open = nextOpenRelease(m);
  const demoRelease = schedule?.demo_release_key ? releaseByKey(plan, schedule.demo_release_key) : null;

  let termValue;
  let termNote = '';
  if (byDate) {
    termValue = `<span class="card-value">${esc(byDate.name || byDate.key)}</span>`;
    termNote = `Current release by its dates (key ${esc(byDate.key)}).`;
  } else if (open) {
    termValue = `<span class="card-value">${esc(open.name || open.key)}</span>`;
    termNote = `The first release that still has unfinished stories (key ${esc(open.key)}). `
      + 'No release in the plan has dates that include today.';
  } else {
    termValue = empty('No releases with stories in the plan yet');
  }
  if (schedule?.demo_day) {
    const n = daysFromToday(schedule.demo_day, m.now);
    termNote += ` Demo day in the plan: ${esc(fmtDay(schedule.demo_day))} (${esc(relDays(n))})`
      + `${demoRelease ? `, demoing ${esc(demoRelease.key)}` : ''}.`;
  } else {
    termNote += ' No demo day in the plan yet.';
  }

  const cards = [
    card(m, {
      href: '#/overview/project',
      title: 'What this is',
      value: name ? `<span class="card-value">${esc(name)}</span>` : empty('Project name not set in the plan yet'),
      note: descriptor ? esc(descriptor) : 'No descriptor in the plan yet.',
    }),
    card(m, { href: '#/overview/term', title: 'Where we are', value: termValue, note: termNote.trim() }),
    card(m, {
      href: '#/overview/stories',
      title: 'Stories verified',
      value: hasNumber(totals?.stories_verified) && hasNumber(totals?.stories_total)
        ? count(totals.stories_verified, totals.stories_total) : empty(NOT_CHECKED),
      note: 'Verified by the platform from your pushed commits.',
    }),
    card(m, {
      href: '#/overview/criteria',
      title: 'Acceptance criteria passed',
      value: hasNumber(totals?.criteria_passed) && hasNumber(totals?.criteria_total)
        ? count(totals.criteria_passed, totals.criteria_total) : empty(NOT_CHECKED),
      note: 'Across every story in the build.',
    }),
    card(m, {
      href: '#/overview/points',
      title: 'Points awarded',
      value: hasNumber(totals?.points_awarded)
        ? `<span class="card-value">${esc(totals.points_awarded)}</span>` : empty(NOT_CHECKED),
      note: 'Awarded when a story verifies.',
    }),
    card(m, {
      href: '#/overview/live',
      title: 'What is live',
      value: systems.length ? liveSummary(m, systems) : empty('No systems named in the plan yet'),
      note: 'Nothing on this page is live. Connections are grey until the running system reports them.',
    }),
    card(m, {
      href: '#/overview/plan-check',
      title: 'Plan check',
      value: checks.length
        ? `<span class="card-value">${esc(checks.length)} <span class="muted">gap${checks.length === 1 ? '' : 's'} in the plan</span></span>`
        : '<span class="card-value">No gaps found</span>',
      note: checks.length ? esc(checks[0]) : 'The plan file has every section this page reads.',
      warn: checks.length > 0,
    }),
  ];

  return `
    ${pageHead(m, 'Overview', 'What is being built, where it is in the term, and what is actually done — read from the project files.')}
    ${grid(cards)}
    <p class="source">Sources: ${esc(m.sources.plan)}, ${esc(m.sources.progress)}, ${esc(m.sources.manifest)}.</p>`;
}

// ---------- detail pages (one level down from each card) ----------

function projectPage(m) {
  const p = m.plan.project ?? {};
  const repo = p.repo_url ? `<a href="${esc(p.repo_url)}">${esc(p.repo_url)}</a>` : null;
  return detail(m, {
    ...BACK,
    title: 'What this is',
    body: `<div class="panel"><dl class="facts">
      ${factRow('Name', projectName(m.plan) ? esc(projectName(m.plan)) : null)}
      ${factRow('Descriptor', projectDescriptor(m.plan) ? esc(projectDescriptor(m.plan)) : null)}
      ${factRow('Repository', repo)}
      ${factRow('Plan version', p.plan_version !== undefined ? esc(p.plan_version) : null)}
      ${factRow('Plan fingerprint', p.plan_sha256 ? `<code>${esc(String(p.plan_sha256).slice(0, 12))}…</code>` : null)}
      ${factRow('Schema version', m.plan.schema_version !== undefined ? esc(m.plan.schema_version) : null)}
    </dl></div>`,
    source: `${m.sources.plan} → project, project_name, descriptor`,
  });
}

function termPage(m) {
  const s = m.plan.schedule;
  const scheduleBlock = s ? `
    <dl class="facts">
      ${factRow('Build starts', fmtDay(s.build_start) ? esc(fmtDay(s.build_start)) : null)}
      ${factRow('Build ends', fmtDay(s.build_end) ? esc(fmtDay(s.build_end)) : null)}
      ${factRow('Demo day', fmtDay(s.demo_day) ? `${esc(fmtDay(s.demo_day))} (${esc(relDays(daysFromToday(s.demo_day, m.now)))})` : null)}
      ${factRow('Demo release', s.demo_release_key ? esc(s.demo_release_key) : null)}
      ${factRow('Build weeks', s.build_weeks !== undefined ? esc(s.build_weeks) : null)}
    </dl>` : '<p class="muted">The plan has no schedule yet.</p>';

  const rows = releases(m.plan).map((r) => `
    <tr>
      <td><code>${esc(String(r.key).length > 12 ? `${String(r.key).slice(0, 8)}…` : r.key)}</code></td>
      <td>${esc(r.name || '')}</td>
      <td>${fmtDay(r.starts_on) ? esc(fmtDay(r.starts_on)) : '<span class="muted">no date</span>'}</td>
      <td>${fmtDay(r.ends_on) ? esc(fmtDay(r.ends_on)) : '<span class="muted">no date</span>'}</td>
      <td>${esc((r.story_ids ?? []).length)}</td>
      <td>${r.is_demo_target ? 'Yes' : ''}</td>
    </tr>`);

  const prep = Array.isArray(s?.prep) && s.prep.length ? `
    <div class="panel"><h3>Demo prep</h3><ul class="checks">
      ${s.prep.map((p) => `<li>${esc(p.title)} — ${fmtDay(p.due_on) ? esc(fmtDay(p.due_on)) : 'no date'}</li>`).join('')}
    </ul></div>` : '';

  const byDate = releaseByDate(m);
  const open = nextOpenRelease(m);
  const where = byDate
    ? `By date, the build is in <strong>${esc(releaseLabel(byDate))}</strong>.`
    : `No release in the plan has dates that include today${open ? `; the first release with open work is <strong>${esc(releaseLabel(open))}</strong>` : ''}.`;

  return detail(m, {
    ...BACK,
    title: 'Where we are',
    body: `
      <div class="panel"><p>${where}</p>${scheduleBlock}</div>
      <div class="panel"><h3>Releases in the plan</h3>
        ${table(['Key', 'Name', 'Starts', 'Ends', 'Stories', 'Demo'], rows, 'No releases in the plan yet.')}
      </div>
      ${prep}`,
    source: `${m.sources.plan} → schedule, releases`,
  });
}

function claimed(story) {
  const crit = story.progress?.criteria ?? [];
  if (!crit.length) return '<span class="muted">no criteria in progress file</span>';
  return `${crit.filter((c) => c.passed === true).length} of ${crit.length}`;
}

function storiesPage(m) {
  const t = m.progress.totals ?? {};
  const rows = m.stories.map((s) => `
    <tr>
      <td><a href="#/project/${esc(s.id)}"><code>${esc(s.id)}</code></a></td>
      <td>${esc(s.title || '')}</td>
      <td>${esc(s.release || '')}</td>
      <td>${fmtDay(s.due_on) ? esc(fmtDay(s.due_on)) : '<span class="muted">no date</span>'}</td>
      <td>${fmtDay(s.due_baseline_on) ? esc(fmtDay(s.due_baseline_on)) : '<span class="muted">no date</span>'}</td>
      <td>${stateLabel(s)}</td>
      <td>${claimed(s)}</td>
    </tr>`);
  const summary = hasNumber(t.stories_total)
    ? `<p>${esc(t.stories_verified ?? 0)} verified, ${esc(t.stories_submitted ?? 0)} submitted, `
      + `${esc(t.stories_in_progress ?? 0)} in progress, ${esc(t.stories_not_started ?? 0)} not started — `
      + `${esc(t.stories_total)} in total.</p>`
    : `<p class="muted">Story totals: ${NOT_CHECKED}.</p>`;
  return detail(m, {
    ...BACK,
    title: 'Stories',
    body: `
      <div class="panel">${summary}
        <p class="muted">"State" is the platform's verification. "Claimed" counts the criteria ticked in progress.json — a claim, not proof, until the platform verifies it.</p>
      </div>
      <div class="panel">${table(['Story', 'Title', 'Release', 'Due now', 'Due first given', 'State', 'Claimed'], rows, 'No stories in the plan yet.')}</div>`,
    source: `${m.sources.plan} → stories, joined on id with ${m.sources.progress} → stories`,
  });
}

function criteriaPage(m) {
  const t = m.progress.totals ?? {};
  const blocks = m.stories.map((s) => {
    const crit = s.progress?.criteria ?? [];
    const items = crit.length
      ? crit.map((c) => `<li>${c.passed === true ? '☑' : '☐'} ${esc(c.text)}</li>`).join('')
      : '<li class="muted">No criteria for this story in the progress file.</li>';
    return `<div class="panel"><h3><code>${esc(s.id)}</code> ${esc(s.title || '')}</h3><ul class="checks">${items}</ul></div>`;
  }).join('');
  const summary = hasNumber(t.criteria_total)
    ? `${esc(t.criteria_passed ?? 0)} of ${esc(t.criteria_total)} passed (platform total).`
    : `Criteria totals: ${NOT_CHECKED}.`;
  return detail(m, {
    ...BACK,
    title: 'Acceptance criteria',
    body: `
      <div class="panel"><p>${summary}</p><p class="muted">☑ means the line is ticked in progress.json. The headline total comes from the platform's totals, not from counting these.</p></div>
      ${blocks || '<p class="muted">No stories in the plan yet.</p>'}`,
    source: `${m.sources.progress} → totals, stories[].criteria`,
  });
}

function pointsPage(m) {
  const t = m.progress.totals ?? {};
  const rows = m.stories.map((s) => {
    const pts = s.verification?.points_awarded;
    return `<tr><td><code>${esc(s.id)}</code></td><td>${esc(s.title || '')}</td>
      <td>${hasNumber(pts) ? esc(pts) : `<span class="muted">${NOT_CHECKED}</span>`}</td></tr>`;
  });
  return detail(m, {
    ...BACK,
    title: 'Points',
    body: `
      <div class="panel"><p>${hasNumber(t.points_awarded) ? `${esc(t.points_awarded)} points awarded (platform total).` : `Points: ${NOT_CHECKED}.`}</p>
        <p class="muted">A story shows points only after the platform has awarded them on a verification.</p></div>
      <div class="panel">${table(['Story', 'Title', 'Points'], rows, 'No stories in the plan yet.')}</div>`,
    source: `${m.sources.progress} → totals.points_awarded, stories[].verification.points_awarded`,
  });
}

function livePage(m) {
  const systems = m.plan.derived?.systems ?? [];
  return detail(m, {
    ...BACK,
    title: 'What is live',
    body: `
      <div class="panel">
        <p>This page is static. It shows the project files as of the stamp at the top, and it cannot reach any system itself.
        A connection only turns green when the running system reports it — until then it stays grey.</p>
        <p>${systems.length ? liveSummary(m, systems) : ''}</p>
        <p><a href="#/systems">Every system, with its status and last-checked time → Systems tab</a></p>
      </div>`,
    source: `${m.sources.plan} → derived.systems (names only)`,
  });
}

function planCheckPage(m) {
  const checks = planChecks(m);
  return detail(m, {
    ...BACK,
    title: 'Plan check',
    body: `
      <div class="panel">
        <p>These are facts about the plan file, found by reading it. Tabs that depend on a missing section show an empty state rather than invented data.
        They fill in on their own when the platform republishes the plan.</p>
        ${checks.length ? `<ul class="checks">${checks.map((c) => `<li>⚠ ${esc(c)}</li>`).join('')}</ul>` : '<p>No gaps found.</p>'}
      </div>`,
    source: m.sources.plan,
  });
}

const DETAIL_PAGES = {
  project: projectPage,
  term: termPage,
  stories: storiesPage,
  criteria: criteriaPage,
  points: pointsPage,
  live: livePage,
  'plan-check': planCheckPage,
};

export const DETAIL_IDS = Object.keys(DETAIL_PAGES);

export function render(m, sub = []) {
  const page = sub[0];
  if (!page) return overviewPage(m);
  const fn = DETAIL_PAGES[page];
  if (!fn) {
    return detail(m, { ...BACK, title: 'Not found', body: `<div class="panel"><p>There is no "${esc(page)}" page under Overview.</p></div>` });
  }
  return fn(m);
}
