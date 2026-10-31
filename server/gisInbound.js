// GIS → work orders (STORY-002, AC2).
//
// GIS owns asset data (address, coordinates, name, type, attributes); the work order system owns
// work order fields (title, priority, status). So a GIS change can only touch the asset-derived
// parts of a work order, and the two sides never overwrite each other.
//
// processGisChanges() polls GIS for numbered changes after the last one processed. Each change is
// applied in its own transaction together with its audit entries and the cursor advance, so:
//   - running it twice never applies a change twice (the cursor has moved past it);
//   - a lost connection before or during the fetch changes nothing (the cursor has not moved);
//   - a change that fails to apply is rolled back and retried on the next run.

import { inTransaction } from './db.js';
import { getWorkOrder, writeAudit } from './workOrders.js';

const CURSOR = 'gis_changes';
export const GIS_ACTOR = 'gis-sync';
const defaultNow = () => new Date().toISOString();

export function readCursor(db) {
  return db.prepare('SELECT value FROM gis_cursor WHERE name = ?').get(CURSOR)?.value ?? 0;
}

function writeCursor(db, value, at) {
  db.prepare(`
    INSERT INTO gis_cursor (name, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(CURSOR, value, at);
}

function primaryAssetId(db, workOrderId) {
  return db.prepare('SELECT asset_id FROM work_order_assets WHERE work_order_id = ? ORDER BY rowid LIMIT 1')
    .get(workOrderId)?.asset_id ?? null;
}

/** Apply one GIS change to every work order that uses the asset. Returns what happened to each. */
function applyChange(db, change, at, audit) {
  const asset = change.asset;
  const links = db.prepare('SELECT * FROM work_order_assets WHERE asset_id = ? ORDER BY rowid').all(change.asset_id);
  const outcomes = [];

  for (const link of links) {
    const before = getWorkOrder(db, link.work_order_id);
    if (before.status === 'completed') {
      outcomes.push({ work_order_id: before.id, asset_id: change.asset_id, result: 'skipped', reason: 'work order is completed' });
      continue;
    }

    const snapshot = {
      asset_type: asset.asset_type ?? null,
      asset_name: asset.name ?? null,
      attributes_json: JSON.stringify(asset.attributes ?? null),
    };
    const snapshotChanged = Object.keys(snapshot).some((k) => snapshot[k] !== link[k]);

    const isPrimary = primaryAssetId(db, before.id) === change.asset_id;
    const location = isPrimary
      ? { address: asset.address ?? null, latitude: asset.location?.lat ?? null, longitude: asset.location?.lng ?? null }
      : {};
    const locationChanged = Object.keys(location).some((k) => location[k] !== before[k]);

    if (!snapshotChanged && !locationChanged) {
      outcomes.push({ work_order_id: before.id, asset_id: change.asset_id, result: 'unchanged' });
      continue;
    }

    db.prepare(`UPDATE work_order_assets SET asset_type = :asset_type, asset_name = :asset_name,
                attributes_json = :attributes_json WHERE work_order_id = :wo AND asset_id = :asset`)
      .run({ ...snapshot, wo: before.id, asset: change.asset_id });
    if (locationChanged) {
      db.prepare('UPDATE work_orders SET address = :address, latitude = :latitude, longitude = :longitude, updated_at = :at, version = version + 1 WHERE id = :id')
        .run({ ...location, at, id: before.id });
    } else {
      db.prepare('UPDATE work_orders SET updated_at = ?, version = version + 1 WHERE id = ?').run(at, before.id);
    }

    const after = getWorkOrder(db, before.id);
    audit(db, {
      entityType: 'work_order',
      entityId: before.id,
      action: 'gis_update',
      actor: GIS_ACTOR,
      before: { ...before, asset: { asset_id: link.asset_id, asset_type: link.asset_type, asset_name: link.asset_name, attributes_json: link.attributes_json } },
      after: { ...after, asset: { asset_id: link.asset_id, ...snapshot }, gis_change_seq: change.seq },
      at,
    });
    outcomes.push({ work_order_id: before.id, asset_id: change.asset_id, result: 'updated' });
  }
  return outcomes;
}

/**
 * Pull GIS changes since the last run and apply them to work orders.
 * Throws if GIS cannot be reached (nothing applied, cursor unchanged). If one change fails to
 * apply, it stops there and reports it in `failed`; the next run resumes from that change.
 *
 * `audit` is only replaceable so tests can prove a failed change is rolled back.
 */
export async function processGisChanges(db, gis, { now = defaultNow, audit = writeAudit } = {}) {
  const start = readCursor(db);
  const { changes } = await gis.getChangesSince(start);
  const result = { from: start, cursor: start, outcomes: [], failed: null };

  for (const change of [...changes].sort((a, b) => a.seq - b.seq)) {
    if (change.seq <= result.cursor) continue; // already processed
    const at = now();
    try {
      const outcomes = inTransaction(db, () => {
        const applied = applyChange(db, change, at, audit);
        writeCursor(db, change.seq, at);
        return applied;
      });
      result.outcomes.push(...outcomes);
      result.cursor = change.seq;
    } catch (err) {
      result.failed = { seq: change.seq, asset_id: change.asset_id, error: String(err?.message ?? err) };
      break; // keep GIS's order: later changes wait until this one applies
    }
  }
  return result;
}
