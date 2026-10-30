// GIS access. Work order code only ever talks to a GIS client made by createGisClient(),
// which adds a timeout and capped retries to every call. Behind it sits either the
// stand-in GIS below (no access to Herriman's real GIS yet) or, later, a real adapter
// with the same two methods: getAsset(id) and linkWorkOrder(assetId, link).

import { readFileSync } from 'node:fs';

export class GisError extends Error {
  /** code: 'error' (default), 'timeout' or 'unauthorized' — used for the GIS log's outcome. */
  constructor(message, { cause, code = 'error' } = {}) {
    super(message, { cause });
    this.name = 'GisError';
    this.code = code;
  }
}

export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new GisError(`${label} timed out after ${ms} ms`, { code: 'timeout' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Retrying a rejected credential never helps and can lock the account, so it fails at once.
const isRetryable = (err) => err?.code !== 'unauthorized';

/** Try fn up to `attempts` times, waiting delayMs × attempt between tries. Rethrows the last error. */
export async function withRetry(fn, { attempts = 3, delayMs = 200, retryable = isRetryable } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (!retryable(err)) break;
      if (attempt < attempts) await sleep(delayMs * attempt);
    }
  }
  throw lastError;
}

/** Writes one gis_log row per GIS call attempt. Pass the result to createGisClient as `log`. */
export function createGisLogger(db) {
  const insert = db.prepare(`
    INSERT INTO gis_log (operation, asset_id, attempt, outcome, error, started_at, finished_at, duration_ms)
    VALUES (:operation, :asset_id, :attempt, :outcome, :error, :started_at, :finished_at, :duration_ms)`);
  return (entry) => insert.run(entry);
}

/**
 * Wrap any GIS backend so every call has an explicit timeout, capped retries, and a log row
 * for every attempt (STORY-002: all GIS interactions are logged with timestamps).
 * `log` is required: a GIS client that cannot log is not allowed to exist.
 *
 * `token` is the GIS credential. It is handed to the backend on every call and never logged.
 * Read it from the environment (gisTokenFromEnv), never from a file in the repo.
 */
export function createGisClient(backend, { log, token = null, timeoutMs = 5000, attempts = 3, delayMs = 200 } = {}) {
  if (typeof log !== 'function') throw new TypeError('createGisClient needs a log function (see createGisLogger)');

  const call = (operation, assetId, fn) => withRetry(async (attempt) => {
    const started = Date.now();
    const entry = (outcome, error = null) => {
      const finished = Date.now();
      log({
        operation,
        asset_id: assetId ?? null,
        attempt,
        outcome,
        error,
        started_at: new Date(started).toISOString(),
        finished_at: new Date(finished).toISOString(),
        duration_ms: finished - started,
      });
    };
    try {
      const result = await withTimeout(fn(), timeoutMs, `GIS ${operation}(${assetId ?? ''})`);
      entry('ok');
      return result;
    } catch (err) {
      const outcome = ['timeout', 'unauthorized'].includes(err?.code) ? err.code : 'error';
      entry(outcome, String(err?.message ?? err));
      throw err;
    }
  }, { attempts, delayMs });

  const auth = { token };
  return {
    kind: backend.kind ?? 'unknown',
    getAsset: (id) => call('getAsset', id, () => backend.getAsset(id, auth)),
    linkWorkOrder: (assetId, link) => call('linkWorkOrder', assetId, () => backend.linkWorkOrder(assetId, link, auth)),
    getChangesSince: (cursor) => call('getChangesSince', null, () => backend.getChangesSince(cursor, auth)),
  };
}

/** The GIS credential from the environment variable GIS_TOKEN, or a clear error if it is not set. */
export function gisTokenFromEnv(env = process.env) {
  const token = env.GIS_TOKEN?.trim();
  if (!token) throw new GisError('GIS_TOKEN is not set: the GIS credential must come from the environment', { code: 'unauthorized' });
  return token;
}

const clone = (v) => (v === null || v === undefined ? null : structuredClone(v));

/**
 * In-memory stand-in for the city's GIS database, seeded from a list of assets.
 * Writes change the in-memory copy only. Clearly not the real GIS: kind is 'stand-in'.
 *
 * Give it `requireToken` to make it behave like a secured GIS: every call must then carry
 * that exact token, or it is refused as unauthorized.
 */
export function createStandInGis(assets, { requireToken = null } = {}) {
  const byId = new Map(assets.map((a) => [a.id, { linked_work_orders: [], ...clone(a) }]));
  const changes = []; // numbered edits to asset data, like a GIS change log
  let seq = 0;
  const checkAuth = (auth) => {
    if (requireToken !== null && auth?.token !== requireToken) {
      throw new GisError('GIS refused the credential (unauthorized)', { code: 'unauthorized' });
    }
  };
  return {
    kind: 'stand-in',
    async getAsset(id, auth) {
      checkAuth(auth);
      return clone(byId.get(id) ?? null);
    },
    /** Record a work order against an asset. Idempotent: the same work order is updated, never duplicated. */
    async linkWorkOrder(assetId, link, auth) {
      checkAuth(auth);
      const asset = byId.get(assetId);
      if (!asset) throw new GisError(`GIS has no asset ${assetId}`);
      const others = asset.linked_work_orders.filter((l) => l.work_order_id !== link.work_order_id);
      asset.linked_work_orders = [...others, clone(link)];
      return clone(asset);
    },
    /** Asset edits numbered after `cursor`, oldest first. */
    async getChangesSince(cursor, auth) {
      checkAuth(auth);
      return { changes: clone(changes.filter((c) => c.seq > cursor)) };
    },
    /**
     * Simulate someone editing an asset in the GIS (address, location, name, type, attributes).
     * Not part of the client interface: in the real system this happens in the city's GIS.
     */
    editAsset(id, edits) {
      const asset = byId.get(id);
      if (!asset) throw new GisError(`GIS has no asset ${id}`);
      for (const field of ['address', 'location', 'name', 'asset_type', 'attributes']) {
        if (field in edits) asset[field] = clone(edits[field]);
      }
      seq += 1;
      const { linked_work_orders: _links, ...data } = asset;
      changes.push({ seq, asset_id: id, changed_at: new Date().toISOString(), asset: clone(data) });
      return seq;
    },
  };
}

export function loadStandInAssets(path = new URL('./gis/stand-in-assets.json', import.meta.url)) {
  return JSON.parse(readFileSync(path, 'utf8')).assets;
}
