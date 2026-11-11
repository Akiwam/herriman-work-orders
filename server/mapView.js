// The map view's data (STORY-016, REQ-058): every matching work order placed where the heat map
// (STORY-005) places it, or listed as "not on the map" with the reason.
//
// The rule for where a work order goes is the heat map's own: its stored coordinates (kept in line
// with GIS by the STORY-002 sync), or else the map pin the citizen gave. The filters are checked by
// the heat map's own normaliseParams, so the map and the heat map always count the same work orders.
// The console draws exactly what this returns and never works out positions itself, so what is
// displayed and what is stored cannot disagree.
//
// Then GIS is asked, through its client (timeout, capped retries), for the current location of each
// linked asset. A difference is flagged, not hidden; if GIS cannot answer, the map says so and still
// shows everything from the stored record.

import { normaliseParams } from './heatMaps.js';

const MAX_POINTS = 5000;
const SAME_PLACE = 1e-6; // degrees: about 10 cm

/** Work orders matching the filters, split into those with a position and those without. */
export function mapPoints(db, input = {}) {
  const { cell_size_m: _ignored, ...params } = normaliseParams({ ...input });
  const where = [];
  const args = [];
  if (params.status !== 'all') { where.push('wo.status = ?'); args.push(params.status); }
  if (params.from) { where.push('wo.created_at >= ?'); args.push(params.from); }
  if (params.to) { where.push('wo.created_at < ?'); args.push(params.to); }
  if (params.work_types) { where.push(`wo.work_type IN (${params.work_types.map(() => '?').join(', ')})`); args.push(...params.work_types); }
  const rows = db.prepare(`
    SELECT wo.id, wo.title, wo.work_type, wo.status, wo.priority, wo.created_at, wo.address, wo.location_text,
           wo.latitude, wo.longitude, sr.latitude AS pin_lat, sr.longitude AS pin_lng,
           (SELECT group_concat(asset_id) FROM work_order_assets a WHERE a.work_order_id = wo.id) AS asset_ids
    FROM work_orders wo
    LEFT JOIN service_requests sr ON sr.work_order_id = wo.id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY wo.created_at DESC, wo.id`).all(...args);

  const points = [];
  const unplaced = [];
  for (const r of rows) {
    const own = r.latitude !== null && r.longitude !== null;
    const pin = !own && r.pin_lat !== null && r.pin_lng !== null;
    const base = { id: r.id, title: r.title, work_type: r.work_type, status: r.status, priority: r.priority, created_at: r.created_at };
    if (!own && !pin) {
      unplaced.push({ ...base, location: r.address ?? r.location_text, reason: 'No coordinates recorded: located by description only' });
      continue;
    }
    points.push({
      ...base,
      lat: own ? r.latitude : r.pin_lat,
      lng: own ? r.longitude : r.pin_lng,
      position_from: own ? 'work order record' : 'citizen map pin',
      asset_ids: own && r.asset_ids ? r.asset_ids.split(',') : [],
      gis_check: 'not_linked',
    });
  }
  return {
    filters: { from: params.from, to: params.to, status: params.status, work_types: params.work_types },
    total: rows.length,
    points: points.slice(0, MAX_POINTS),
    truncated: points.length > MAX_POINTS,
    unplaced,
    empty: rows.length === 0,
  };
}

/**
 * Check each plotted work order's linked asset against GIS as it is now. Positions are never moved:
 * a point stays where the stored record says, and a difference is flagged for the sync to resolve.
 */
export async function withGisCheck(map, gis) {
  const linked = map.points.filter((p) => p.asset_ids.length);
  if (!linked.length) return { ...map, gis_status: 'no_assets' };
  if (!gis) return { ...map, gis_status: 'not_connected', points: map.points.map((p) => (p.asset_ids.length ? { ...p, gis_check: 'not_checked' } : p)) };
  const ids = [...new Set(linked.map((p) => p.asset_ids[0]))];
  let live;
  try {
    live = new Map((await Promise.all(ids.map((id) => gis.getAsset(id)))).map((a, i) => [ids[i], a]));
  } catch (err) {
    return {
      ...map, gis_status: 'unavailable', gis_error: String(err.message ?? err).slice(0, 200),
      points: map.points.map((p) => (p.asset_ids.length ? { ...p, gis_check: 'not_checked' } : p)),
    };
  }
  return {
    ...map,
    gis_status: 'live',
    points: map.points.map((p) => {
      if (!p.asset_ids.length) return p;
      const asset = live.get(p.asset_ids[0]);
      if (!asset?.location) return { ...p, gis_check: 'missing_in_gis' };
      const same = Math.abs(asset.location.lat - p.lat) < SAME_PLACE && Math.abs(asset.location.lng - p.lng) < SAME_PLACE;
      return same ? { ...p, gis_check: 'matches' } : { ...p, gis_check: 'differs', gis_location: { lat: asset.location.lat, lng: asset.location.lng } };
    }),
  };
}
