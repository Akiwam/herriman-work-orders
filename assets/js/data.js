// The one place the Command Center gets its data from.
// Every tab receives the model built here and nothing else, so pointing the page
// at a new source (or at the real running system later) only changes this file.

export const SOURCES = {
  real: {
    plan: '.colaberry/plan.json',
    progress: '.colaberry/progress.json',
    notes: 'knowledge/notes.json',
  },
  sample: {
    plan: 'assets/sample/plan.json',
    progress: 'assets/sample/progress.json',
    notes: 'assets/sample/notes.json',
  },
};

// Freshness always comes from the real manifest, in both modes.
export const MANIFEST = '.colaberry/manifest.json';

// The proposed data model is a design, not data, so it is the same in both modes.
export const DATA_MODEL = 'knowledge/data-model.json';

const MODE_KEY = 'command-center-mode';

async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
  return res.json();
}

/** For files the page can live without: a 404 means "not written yet", anything else is a real error. */
async function getOptionalJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
  return res.json();
}

/** Current mode: ?mode= in the URL wins, then the viewer's last choice, else Real. */
export function getMode() {
  const fromUrl = new URLSearchParams(window.location.search).get('mode');
  if (fromUrl === 'sample' || fromUrl === 'real') return fromUrl;
  try {
    return window.localStorage.getItem(MODE_KEY) === 'sample' ? 'sample' : 'real';
  } catch (err) {
    console.warn('Browser storage unavailable; defaulting to Real data.', err);
    return 'real';
  }
}

export function rememberMode(mode) {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch (err) {
    console.warn('Browser storage unavailable; the mode will reset on reload.', err);
  }
}

/** Fetch the files for a mode and join them. */
export async function loadModel(mode) {
  const src = SOURCES[mode] ?? SOURCES.real;
  const [plan, progress, manifest, notes, dataModel] = await Promise.all([
    getJSON(src.plan),
    getJSON(src.progress),
    getJSON(MANIFEST),
    getOptionalJSON(src.notes),
    getOptionalJSON(DATA_MODEL),
  ]);
  return buildModel({
    mode, plan, progress, manifest, notes, dataModel, sources: { ...src, manifest: MANIFEST, dataModel: DATA_MODEL },
  });
}

/**
 * Pure join of plan + progress on story id (see docs/DATA_CONTRACT.md).
 * Completion only ever comes from progress.verification; absent means "not checked yet".
 */
export function buildModel({
  mode = 'real', plan, progress, manifest, notes = null, dataModel = null, sources = {}, now = Date.now(),
}) {
  const progressStories = Array.isArray(progress?.stories) ? progress.stories : [];
  const progressById = new Map(progressStories.map((s) => [s.id, s]));

  const stories = (Array.isArray(plan?.stories) ? plan.stories : []).map((story) => {
    const p = progressById.get(story.id) ?? null;
    const verification = p?.verification ?? null;
    return {
      ...story,
      progress: p,
      verification,
      state: verification?.state ?? null, // null = no verification run yet
    };
  });

  // Connection status is a fact about the running system, which does not exist yet.
  // Real mode therefore knows nothing; sample mode carries made-up statuses.
  const systemStatus = mode === 'sample' ? (plan?.sample_system_status ?? {}) : {};
  // Same for measure values: the plan holds targets, never measurements.
  const measurements = mode === 'sample' ? (plan?.sample_measurements ?? {}) : {};

  return {
    mode,
    plan: plan ?? {},
    progress: progress ?? {},
    manifest: manifest ?? {},
    notes,
    dataModel,
    sources,
    stories,
    progressById,
    systemStatus,
    measurements,
    now,
  };
}
