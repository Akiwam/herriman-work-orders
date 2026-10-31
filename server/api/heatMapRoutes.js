// Heat maps over HTTP (STORY-005). Needs scope heatmaps:read — planners and staff only, never public,
// because a cell holding a single work order can point to one citizen's report.
//
//   GET /api/v1/heat-maps?format=svg|geojson&work_types=pothole,streetlight&from=…&to=…&status=…&cell_size_m=…
//
// Every request is logged in heat_map_log by generateHeatMap (who = the calling system).

import { requireAccess, HEATMAPS_SCOPE } from './clients.js';
import { generateHeatMap } from '../heatMaps.js';
import { send } from './http.js';

export const HEAT_MAP_PATH = '/api/v1/heat-maps';

/** Query string → heat map parameters. work_types is a comma-separated list. */
function paramsFromQuery(searchParams) {
  const params = Object.fromEntries([...searchParams].filter(([k]) => k !== 'format'));
  if (typeof params.work_types === 'string') params.work_types = params.work_types.split(',').map((t) => t.trim()).filter(Boolean);
  return params;
}

export function handleHeatMap(req, res, db, url, { key, now } = {}) {
  if (req.method !== 'GET') {
    send(res, 405, { error: 'method_not_allowed', message: 'Use GET here' }, { Allow: 'GET' });
    return;
  }
  const params = paramsFromQuery(url.searchParams);
  const format = url.searchParams.get('format') ?? 'geojson';
  const client = requireAccess(db, { key, operation: 'generateHeatMap', params: { ...params, format }, scope: HEATMAPS_SCOPE });

  const { content } = generateHeatMap(db, params, { requestedBy: client.name, format, ...(now ? { now } : {}) });

  if (format === 'svg') {
    const body = Buffer.from(content, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Content-Length': body.length,
      // An image, nothing more: no scripts, nothing loaded from anywhere, cannot act as a page.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } else {
    const body = Buffer.from(JSON.stringify(content), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'application/geo+json; charset=utf-8',
      'Content-Length': body.length,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  }
}
