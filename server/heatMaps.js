// Heat maps of work orders (STORY-005, REQ-031): how many work orders fall in each square of a grid,
// filtered by work type, date and status.
//
// Where a work order is: its own coordinates (autofilled from a GIS asset), or else the map pin a
// citizen gave with their request (service_requests). Work orders with neither cannot be placed on a
// map; they are left out but counted, so a heat map always says how much of the data it shows.
// The numbers always reconcile: sum of cell counts + unmapped = work orders matching the filters.

import { ValidationError } from './workOrders.js';
import { getSetting } from './settings.js';

// Grid cells are squares of cell_size_m metres. Converting metres to degrees of longitude depends on
// latitude; one fixed reference latitude (Herriman, Utah, about 40.5°N) keeps every heat map on the
// same grid, so cells from different runs line up and can be compared.
export const REFERENCE_LATITUDE = 40.5;
const METRES_PER_DEGREE_LAT = 111_320;
export const CELL_SIZE = { min: 50, max: 2000, default: 250 }; // default is the built-in one; administrators change it with heat_maps.default_cell_size_m
export const STATUSES = ['all', 'open', 'completed'];
const ALLOWED_PARAMS = ['cell_size_m', 'work_types', 'from', 'to', 'status'];

const isIso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/** Check the parameters and return them normalised. Every problem is listed at once. */
export function normaliseParams(input = {}, { defaultCellSize = CELL_SIZE.default } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError(['parameters must be an object']);
  const problems = Object.keys(input).filter((k) => !ALLOWED_PARAMS.includes(k)).map((k) => `${k} is not a heat map parameter`);

  let cellSize = defaultCellSize;
  if (input.cell_size_m !== undefined) {
    cellSize = Number(input.cell_size_m);
    if (!Number.isInteger(cellSize) || cellSize < CELL_SIZE.min || cellSize > CELL_SIZE.max) {
      problems.push(`cell_size_m must be a whole number from ${CELL_SIZE.min} to ${CELL_SIZE.max}`);
    }
  }

  let workTypes = null;
  if (input.work_types !== undefined && input.work_types !== null) {
    if (!Array.isArray(input.work_types) || !input.work_types.every((t) => typeof t === 'string' && t.trim())) {
      problems.push('work_types must be a list of work type names');
    } else {
      workTypes = [...new Set(input.work_types.map((t) => t.trim()))].sort();
    }
  }

  const status = input.status ?? 'all';
  if (!STATUSES.includes(status)) problems.push(`status must be one of: ${STATUSES.join(', ')}`);

  for (const f of ['from', 'to']) if (input[f] !== undefined && input[f] !== null && !isIso(input[f])) problems.push(`${f} must be an ISO date or date-time`);
  const from = isIso(input.from) ? new Date(input.from).toISOString() : null;
  const to = isIso(input.to) ? new Date(input.to).toISOString() : null;
  if (from && to && from >= to) problems.push('from must be before to');

  if (problems.length) throw new ValidationError(problems);
  return { cell_size_m: cellSize, work_types: workTypes, from, to, status };
}

/** The size of one grid cell in degrees, for a cell size in metres. */
export function cellDegrees(cellSizeM) {
  const lat = cellSizeM / METRES_PER_DEGREE_LAT;
  const lng = cellSizeM / (METRES_PER_DEGREE_LAT * Math.cos((REFERENCE_LATITUDE * Math.PI) / 180));
  return { lat, lng };
}

const validCoordinate = (lat, lng) => typeof lat === 'number' && typeof lng === 'number'
  && Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;

/** The work orders matching the filters, each with the best coordinates available (or null). */
function matchingWorkOrders(db, p) {
  const where = [];
  const args = [];
  if (p.status !== 'all') { where.push('wo.status = ?'); args.push(p.status); }
  if (p.from) { where.push('wo.created_at >= ?'); args.push(p.from); }
  if (p.to) { where.push('wo.created_at < ?'); args.push(p.to); }
  if (p.work_types) { where.push(`wo.work_type IN (${p.work_types.map(() => '?').join(', ')})`); args.push(...p.work_types); }
  return db.prepare(`
    SELECT wo.id, wo.work_type,
           COALESCE(wo.latitude, sr.latitude)   AS lat,
           COALESCE(wo.longitude, sr.longitude) AS lng
    FROM work_orders wo
    LEFT JOIN service_requests sr ON sr.work_order_id = wo.id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`).all(...args);
}

/**
 * Count matching work orders per grid cell. Returns the cells (busiest first), how many work orders
 * matched, how many were placed and how many could not be, and the area covered. Only counts leave
 * this function — never individual work orders.
 */
export function analyzeWorkOrders(db, input = {}) {
  const params = normaliseParams(input, { defaultCellSize: getSetting(db, 'heat_maps.default_cell_size_m') });
  const size = cellDegrees(params.cell_size_m);
  const rows = matchingWorkOrders(db, params);

  const cells = new Map();
  let unmapped = 0;
  for (const r of rows) {
    if (!validCoordinate(r.lat, r.lng)) { unmapped += 1; continue; }
    const row = Math.floor(r.lat / size.lat);
    const col = Math.floor(r.lng / size.lng);
    const id = `${row}:${col}`;
    if (!cells.has(id)) {
      cells.set(id, {
        cell_id: id, row, col,
        bounds: { south: row * size.lat, west: col * size.lng, north: (row + 1) * size.lat, east: (col + 1) * size.lng },
        count: 0, by_type: {},
      });
    }
    const c = cells.get(id);
    c.count += 1;
    c.by_type[r.work_type] = (c.by_type[r.work_type] ?? 0) + 1;
  }

  const list = [...cells.values()].sort((a, b) => b.count - a.count || a.cell_id.localeCompare(b.cell_id));
  const mapped = rows.length - unmapped;
  const area = list.length ? {
    south: Math.min(...list.map((c) => c.bounds.south)), west: Math.min(...list.map((c) => c.bounds.west)),
    north: Math.max(...list.map((c) => c.bounds.north)), east: Math.max(...list.map((c) => c.bounds.east)),
  } : null;

  return {
    params,
    total_matching: rows.length,
    mapped,
    unmapped,
    max_count: list[0]?.count ?? 0,
    area,
    cells: list,
  };
}

// ---------- drawing the map ----------

export const FORMATS = ['geojson', 'svg'];
// A heat map with more cells than this is refused rather than drawn: it would be unreadable and slow.
export const MAX_CELLS = 5000;
// …and so is one whose grid would span more squares than this (very small cells over a wide area).
export const MAX_GRID_SQUARES = 250_000;

/** The map could not be drawn (too detailed, or the renderer failed). Nothing is returned. */
export class MapGenerationError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'MapGenerationError';
  }
}

// Five shades from light to dark. Colours live here only.
export const HEAT_COLOURS = ['#fde0c5', '#facba6', '#f59e72', '#e8613c', '#b8321c'];

/** Which shade a count gets: the share of the busiest cell, in five equal steps. */
export function shadeIndex(count, maxCount) {
  if (maxCount <= 0) return 0;
  return Math.min(HEAT_COLOURS.length - 1, Math.floor((count / maxCount) * HEAT_COLOURS.length - 1e-9));
}

/** GeoJSON: one square polygon per cell, with its count, share and breakdown by type. Loads into any GIS. */
export function toGeoJSON(result) {
  return {
    type: 'FeatureCollection',
    properties: {
      params: result.params, total_matching: result.total_matching, mapped: result.mapped, unmapped: result.unmapped, max_count: result.max_count,
    },
    features: result.cells.map((c) => {
      const { south, west, north, east } = c.bounds;
      return {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] },
        properties: { cell_id: c.cell_id, count: c.count, share: result.max_count ? c.count / result.max_count : 0, by_type: c.by_type },
      };
    }),
  };
}

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const xml = (v) => String(v).replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch]);

/** SVG: coloured cells in their true relative positions, with a legend and a line saying how much data is shown. */
export function toSvg(result) {
  const W = 800;
  const pad = 20;
  const p = result.params;
  const filters = [
    p.work_types ? `types: ${p.work_types.join(', ')}` : 'all types',
    p.status === 'all' ? 'any status' : p.status,
    p.from || p.to ? `${p.from?.slice(0, 10) ?? '…'} to ${p.to?.slice(0, 10) ?? '…'}` : 'all dates',
    `${p.cell_size_m} m cells`,
  ].join(' · ');
  const coverage = `${result.mapped} of ${result.total_matching} work orders mapped`
    + (result.unmapped ? `; ${result.unmapped} have no coordinates` : '');

  let body = `<text x="${W / 2}" y="160" text-anchor="middle" font-size="16" fill="#555">No work orders with coordinates match these filters.</text>`;
  let H = 320;
  if (result.cells.length) {
    const { south, west, north, east } = result.area;
    const kx = Math.cos((REFERENCE_LATITUDE * Math.PI) / 180); // longitude degrees are shorter than latitude degrees
    const scale = (W - 2 * pad) / ((east - west) * kx);
    const mapH = Math.max(40, (north - south) * scale);
    H = mapH + 140;
    const x = (lng) => pad + (lng - west) * kx * scale;
    const y = (lat) => 60 + (north - lat) * scale;
    body = result.cells.map((c) => {
      const shade = shadeIndex(c.count, result.max_count);
      const b = c.bounds;
      return `<rect class="cell" data-cell="${xml(c.cell_id)}" data-count="${c.count}" data-shade="${shade}" x="${x(b.west).toFixed(1)}" y="${y(b.north).toFixed(1)}" `
        + `width="${Math.max(1, (b.east - b.west) * kx * scale).toFixed(1)}" height="${Math.max(1, (b.north - b.south) * scale).toFixed(1)}" `
        + `fill="${HEAT_COLOURS[shade]}" stroke="#ffffff" stroke-width="0.5"><title>${c.count} work order${c.count === 1 ? '' : 's'}</title></rect>`;
    }).join('');
  }

  const legendY = H - 60;
  const legend = HEAT_COLOURS.map((colour, i) => {
    const lo = Math.max(1, Math.ceil((i / HEAT_COLOURS.length) * result.max_count));
    return `<rect x="${pad + i * 70}" y="${legendY}" width="70" height="14" fill="${colour}"/>`
      + `<text x="${pad + i * 70}" y="${legendY + 28}" font-size="11" fill="#333">${lo}+</text>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Math.round(H)}" viewBox="0 0 ${W} ${Math.round(H)}" font-family="system-ui, sans-serif">`
    + '<rect width="100%" height="100%" fill="#ffffff"/>'
    + `<text x="${pad}" y="28" font-size="18" font-weight="600" fill="#1c2430">Work order heat map</text>`
    + `<text x="${pad}" y="46" font-size="12" fill="#555">${xml(filters)}</text>`
    + body
    + legend
    + `<text x="${pad + 360}" y="${legendY + 12}" font-size="12" fill="#333">work orders per cell (darkest = ${result.max_count})</text>`
    + `<text x="${pad}" y="${H - 12}" font-size="12" fill="#333">${xml(coverage)}. No street map: load the GeoJSON into the city GIS for one.</text>`
    + '</svg>';
}

// ---------- generating, with a log row for every attempt ----------

const RENDERERS = { geojson: toGeoJSON, svg: toSvg };

function writeLog(db, entry) {
  db.prepare(`INSERT INTO heat_map_log (requested_by, format, params_json, started_at, finished_at, duration_ms, outcome, error,
                total_matching, mapped, unmapped, cell_count)
              VALUES (:requested_by, :format, :params_json, :started_at, :finished_at, :duration_ms, :outcome, :error,
                :total_matching, :mapped, :unmapped, :cell_count)`).run(entry);
}

/**
 * Analyse and draw a heat map, writing one heat_map_log row whatever happens:
 *   'invalid' — bad parameters or format (ValidationError is rethrown)
 *   'failed'  — too detailed to draw, or the renderer failed (MapGenerationError)
 *   'ok'      — the map is returned as { format, content, summary }
 * If the log row itself cannot be written, the map is not returned: every generation is logged.
 *
 * `render` is only replaceable so tests can prove a renderer failure is caught and logged.
 */
export function generateHeatMap(db, input = {}, { requestedBy, format = 'geojson', now = () => new Date().toISOString(), render = null } = {}) {
  if (typeof requestedBy !== 'string' || !requestedBy.trim()) throw new TypeError('generateHeatMap needs requestedBy (who is asking)');
  const startedAt = now();
  const t0 = Date.now();
  const log = (outcome, { error = null, result = null, params = input } = {}) => writeLog(db, {
    requested_by: requestedBy.trim(),
    format: FORMATS.includes(format) ? format : String(format).slice(0, 20),
    params_json: JSON.stringify(params ?? {}),
    started_at: startedAt,
    finished_at: now(),
    duration_ms: Date.now() - t0,
    outcome,
    error,
    total_matching: result?.total_matching ?? null,
    mapped: result?.mapped ?? null,
    unmapped: result?.unmapped ?? null,
    cell_count: result?.cells.length ?? null,
  });

  let result;
  try {
    if (!FORMATS.includes(format)) throw new ValidationError([`format must be one of: ${FORMATS.join(', ')}`]);
    result = analyzeWorkOrders(db, input);
  } catch (err) {
    if (err instanceof ValidationError) {
      log('invalid', { error: err.problems.join('; ') });
      throw err;
    }
    log('failed', { error: String(err?.message ?? err) });
    throw new MapGenerationError('The work order data could not be analysed. Please try again later.', { cause: err });
  }

  let content;
  try {
    if (result.cells.length > MAX_CELLS) {
      throw new MapGenerationError(`This heat map would have ${result.cells.length} cells (the limit is ${MAX_CELLS}). Use larger cells or narrower filters.`);
    }
    if (result.area) {
      const size = cellDegrees(result.params.cell_size_m);
      const squares = Math.round((result.area.north - result.area.south) / size.lat) * Math.round((result.area.east - result.area.west) / size.lng);
      if (squares > MAX_GRID_SQUARES) {
        throw new MapGenerationError(`These cells are too small for an area this wide (${squares} grid squares; the limit is ${MAX_GRID_SQUARES}). Use larger cells or narrower filters.`);
      }
    }
    content = (render ?? RENDERERS[format])(result);
  } catch (err) {
    const failure = err instanceof MapGenerationError ? err : new MapGenerationError('The heat map could not be drawn.', { cause: err });
    log('failed', { error: failure.message, result, params: result.params });
    throw failure;
  }

  log('ok', { result, params: result.params });
  const { cells, ...summary } = result;
  return { format, content, summary: { ...summary, cell_count: cells.length } };
}
