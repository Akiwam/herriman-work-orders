// Read-only questions about the model that more than one tab asks.
// Nothing here stores state: completion is always derived from progress.verification.

import { daysFromToday } from './format.js';

export function projectName(plan) {
  return (plan.project?.name || plan.project_name || '').trim();
}

export function projectDescriptor(plan) {
  return (plan.project?.descriptor || plan.descriptor || '').trim();
}

export function releases(plan) {
  return Array.isArray(plan.releases) ? plan.releases : [];
}

/** Releases that actually carry stories, in plan order. */
export function workingReleases(plan) {
  return releases(plan).filter((r) => Array.isArray(r.story_ids) && r.story_ids.length > 0);
}

export function releaseByKey(plan, key) {
  return releases(plan).find((r) => r.key === key) ?? null;
}

export function releaseLabel(r) {
  if (!r) return '';
  return r.name ? `${r.key} · ${r.name}` : r.key;
}

/** The release whose dates contain today, if the plan has dates. */
export function releaseByDate(m) {
  return workingReleases(m.plan).find((r) => {
    const start = daysFromToday(r.starts_on, m.now);
    const end = daysFromToday(r.ends_on, m.now);
    return start !== null && end !== null && start <= 0 && end >= 0;
  }) ?? null;
}

/** First release (plan order) that still has a story not verified. */
export function nextOpenRelease(m) {
  const byId = new Map(m.stories.map((s) => [s.id, s]));
  return workingReleases(m.plan).find((r) =>
    r.story_ids.some((id) => byId.get(id)?.state !== 'verified')) ?? null;
}

export function requirements(plan) {
  return Array.isArray(plan.requirements) ? plan.requirements : [];
}

export function requirementById(plan, id) {
  return requirements(plan).find((r) => r.id === id) ?? null;
}

export function storyById(m, id) {
  return m.stories.find((s) => s.id === id) ?? null;
}

/** Story ids that fulfil a requirement: from requirement.fulfilled_by, else from stories[].fulfills. */
export function storyIdsFor(m, reqId) {
  const req = requirementById(m.plan, reqId);
  if (req && Array.isArray(req.fulfilled_by) && req.fulfilled_by.length) return req.fulfilled_by;
  return m.stories.filter((s) => (s.fulfills ?? []).includes(reqId)).map((s) => s.id);
}

/**
 * Whether anything enforces a requirement yet.
 * 'kept'      every fulfilling story is verified
 * 'not_kept'  stories exist but not all are verified
 * 'no_story'  nothing is written to fulfil it
 */
export function enforcement(m, reqId) {
  const ids = storyIdsFor(m, reqId);
  if (!ids.length) return { status: 'no_story', ids, stories: [] };
  const stories = ids.map((id) => storyById(m, id)).filter(Boolean);
  const kept = stories.length === ids.length && stories.every((s) => s.state === 'verified');
  return { status: kept ? 'kept' : 'not_kept', ids, stories };
}

/** Requirement ids that stories point at, in first-seen order — including ids missing from plan.requirements. */
export function referencedRequirementIds(m) {
  const seen = new Set();
  for (const s of m.stories) for (const id of s.fulfills ?? []) seen.add(id);
  return [...seen];
}

export function slug(value) {
  return String(value ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'none';
}
