// GIS access. Work order code only ever talks to a GIS client made by createGisClient(),
// which adds a timeout and capped retries to every call. Behind it sits either the
// stand-in GIS below (no access to Herriman's real GIS yet) or, later, a real adapter
// with the same two methods: getAsset(id) and linkWorkOrder(assetId, link).

import { readFileSync } from 'node:fs';

export class GisError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'GisError';
  }
}

export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new GisError(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Try fn up to `attempts` times, waiting delayMs × attempt between tries. Rethrows the last error. */
export async function withRetry(fn, { attempts = 3, delayMs = 200 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await sleep(delayMs * attempt);
    }
  }
  throw lastError;
}

/** Wrap any GIS backend so every call has an explicit timeout and capped retries. */
export function createGisClient(backend, { timeoutMs = 5000, attempts = 3, delayMs = 200 } = {}) {
  const call = (label, fn) => withRetry(() => withTimeout(fn(), timeoutMs, label), { attempts, delayMs });
  return {
    kind: backend.kind ?? 'unknown',
    getAsset: (id) => call(`GIS getAsset(${id})`, () => backend.getAsset(id)),
    linkWorkOrder: (assetId, link) => call(`GIS linkWorkOrder(${assetId})`, () => backend.linkWorkOrder(assetId, link)),
  };
}

const clone = (v) => (v === null || v === undefined ? null : structuredClone(v));

/**
 * In-memory stand-in for the city's GIS database, seeded from a list of assets.
 * Writes change the in-memory copy only. Clearly not the real GIS: kind is 'stand-in'.
 */
export function createStandInGis(assets) {
  const byId = new Map(assets.map((a) => [a.id, { linked_work_orders: [], ...clone(a) }]));
  return {
    kind: 'stand-in',
    async getAsset(id) {
      return clone(byId.get(id) ?? null);
    },
    /** Record a work order against an asset. Idempotent: the same work order is updated, never duplicated. */
    async linkWorkOrder(assetId, link) {
      const asset = byId.get(assetId);
      if (!asset) throw new GisError(`GIS has no asset ${assetId}`);
      const others = asset.linked_work_orders.filter((l) => l.work_order_id !== link.work_order_id);
      asset.linked_work_orders = [...others, clone(link)];
      return clone(asset);
    },
  };
}

export function loadStandInAssets(path = new URL('./gis/stand-in-assets.json', import.meta.url)) {
  return JSON.parse(readFileSync(path, 'utf8')).assets;
}
