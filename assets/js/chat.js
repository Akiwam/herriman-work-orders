// Knowledge-base chat. Answers only from the model the page already has, and says which tab
// the answer came from. It is a lookup, not a language model: anything it cannot find in the
// project files, it says so rather than guessing.

import { fmtDay, freshness } from './format.js';
import {
  requirements, requirementById, releases, workingReleases, storyById, storyIdsFor, enforcement, referencedRequirementIds,
} from './plan.js';
import { STATE_LABELS } from './ui.js';

const CANNOT = 'I cannot answer that from this project\'s files. Try asking about stories (by id, e.g. "STORY-nnn"), releases, due dates, '
  + 'requirements (by id, "REQ-nnn"), guardrails, systems, measures, roles, owners, demo day or how old the data is.';

const stateText = (s) => (s?.state ? (STATE_LABELS[s.state] ?? s.state) : 'not checked yet');
const day = (v) => fmtDay(v) ?? 'no date in the plan';

function storyAnswer(m, id, q) {
  const s = storyById(m, id);
  if (!s) return { text: `There is no ${id} in the plan.`, tab: 'Project management' };
  if (/\b(due|when|date|deadline)\b/.test(q)) {
    return { text: `${id} is due ${day(s.due_on)} (first given as ${day(s.due_baseline_on)}).`, tab: 'Project management' };
  }
  if (/\b(own|owner|who)\b/.test(q)) {
    return { text: `${id} is owned by ${s.owner_agent || 'no one — the plan sets no owner'}.`, tab: 'AI agents' };
  }
  if (/\b(require|fulfil|fulfill|req)\w*/.test(q)) {
    return { text: `${id} fulfils ${(s.fulfills ?? []).join(', ') || 'no requirement'}.`, tab: 'Knowledge base' };
  }
  const crit = s.progress?.criteria ?? [];
  return {
    text: `${id} — "${s.title}". Release ${s.release ?? 'none'}, state: ${stateText(s)}, `
      + `${crit.filter((c) => c.passed === true).length} of ${crit.length} criteria ticked in progress.json, due ${day(s.due_on)}.`,
    tab: 'Project management',
  };
}

function requirementAnswer(m, id) {
  const req = requirementById(m.plan, id);
  const ids = storyIdsFor(m, id);
  const e = enforcement(m, id);
  const kept = e.status === 'kept' ? 'all of them verified' : 'not all verified yet';
  if (req) {
    return {
      text: `${id} (${req.kind}, ${req.priority}): ${req.statement} Fulfilled by ${ids.join(', ') || 'no story yet'}${ids.length ? ` — ${kept}` : ''}.`,
      tab: 'Knowledge base',
    };
  }
  if (ids.length) {
    return { text: `${id} is referenced by ${ids.join(', ')}, but its statement is not in the plan's requirements.`, tab: 'Knowledge base' };
  }
  return { text: `${id} is not in the plan.`, tab: 'Knowledge base' };
}

export function answer(question, m) {
  const q = String(question ?? '').toLowerCase().trim();
  if (!q) return { text: 'Ask a question about this project.', tab: null };

  const storyMatch = q.match(/story[\s-]?(\d{1,3})/);
  if (storyMatch) return storyAnswer(m, `STORY-${storyMatch[1].padStart(3, '0')}`, q);

  const reqMatch = q.match(/req[\s-]?(\d{1,3})/);
  if (reqMatch) return requirementAnswer(m, `REQ-${reqMatch[1].padStart(3, '0')}`);

  const t = m.progress.totals ?? null;
  const d = m.plan.derived ?? {};

  if (/\b(data as of|how old|fresh|stale|sync|synced|up to date)\b/.test(q)) {
    return { text: freshness(m.manifest.generated_at, m.now).text, tab: 'every tab (header)' };
  }
  if (/\bpoints?\b/.test(q)) {
    return t ? { text: `${t.points_awarded} points awarded.`, tab: 'Overview' } : { text: 'Points: not checked yet.', tab: 'Overview' };
  }
  if (/\bcriteri/.test(q)) {
    return t ? { text: `${t.criteria_passed} of ${t.criteria_total} acceptance criteria passed.`, tab: 'Overview' } : { text: 'Criteria: not checked yet.', tab: 'Overview' };
  }
  if (/\bdemo\b/.test(q)) {
    const s = m.plan.schedule;
    return s?.demo_day
      ? { text: `Demo day in the plan is ${day(s.demo_day)}${s.demo_release_key ? `, demoing ${s.demo_release_key}` : ''}.`, tab: 'Project management' }
      : { text: 'The plan has no demo day yet.', tab: 'Project management' };
  }
  if (/\breleases?\b/.test(q)) {
    const w = workingReleases(m.plan);
    return {
      text: `${releases(m.plan).length} releases in the plan, ${w.length} with stories: `
        + `${w.map((r) => `${r.key} (${r.story_ids.length})`).join(', ') || 'none'}.`,
      tab: 'Project management',
    };
  }
  if (/\bguardrails?|\bsafe\b|must never/.test(q)) {
    const g = d.guardrails ?? [];
    return { text: g.length ? `Guardrails: ${g.map((x) => `${x.id} — ${x.statement}`).join(' | ')}` : 'The plan has no guardrails yet.', tab: 'Guardrails' };
  }
  if (/\b(systems?|integrations?|connect\w*)\b/.test(q)) {
    const s = d.systems ?? [];
    return {
      text: s.length ? `Systems named in the plan: ${s.join(', ')}. None is checked from this page.` : 'The plan names no systems yet.',
      tab: 'Systems',
    };
  }
  if (/\b(measures?|outcomes?|kpis?|metrics?)\b/.test(q)) {
    const ms = d.measures ?? [];
    return { text: ms.length ? `Measures: ${ms.map((x) => `${x.id} — ${x.statement}`).join(' | ')} (not measured yet).` : 'The plan has no measures yet.', tab: 'Outcomes' };
  }
  if (/\b(roles?|users?|who is (it|this) for)\b/.test(q)) {
    const r = d.roles ?? [];
    return { text: r.length ? `Roles in the stories: ${r.join(', ')}.` : 'The plan has no roles yet.', tab: 'Users & use case' };
  }
  if (/\b(agents?|owners?|owns)\b/.test(q)) {
    const a = m.plan.agents ?? [];
    if (a.length) return { text: `Agents: ${a.map((x) => x.name ?? x.id).join(', ')}.`, tab: 'AI agents' };
    const owners = [...new Set(m.stories.map((s) => s.owner_agent).filter(Boolean))];
    return { text: `The plan has no AI agents yet. Story owners: ${owners.join(', ') || 'none'}.`, tab: 'AI agents' };
  }
  if (/\brequirements?\b/.test(q)) {
    const n = requirements(m.plan).length;
    const refs = referencedRequirementIds(m);
    return {
      text: n ? `${n} requirements in the plan.` : `The plan's requirements list is empty. Stories reference ${refs.length} requirement ids: ${refs.join(', ')}.`,
      tab: 'Knowledge base',
    };
  }
  if (/\bstor(y|ies)\b|\bverified\b|\bdone\b|\bprogress\b/.test(q)) {
    return t
      ? { text: `${t.stories_verified} of ${t.stories_total} stories verified (${t.stories_in_progress} in progress, ${t.stories_not_started} not started).`, tab: 'Overview' }
      : { text: `${m.stories.length} stories in the plan; verification not checked yet.`, tab: 'Overview' };
  }
  if (/\b(tables?|data model|schema|entit\w*)\b/.test(q)) {
    const n = m.dataModel?.entities?.length ?? 0;
    return { text: n ? `The proposed data model has ${n} tables: ${m.dataModel.entities.map((e) => e.name).join(', ')}.` : 'No data model has been written yet.', tab: 'Data model' };
  }
  return { text: CANNOT, tab: null };
}
