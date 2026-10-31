// System settings over HTTP (STORY-008, REQ-047).
//
//   GET    /api/v1/settings         every setting: value, default, range, version, who changed it last
//   GET    /api/v1/settings/{key}   one setting; its version is the ETag
//   PUT    /api/v1/settings/{key}   change it: { value }        — If-Match: "v<version>" required
//   DELETE /api/v1/settings/{key}   back to the default         — If-Match required
//
// All need settings:admin, and changes need a person's own key: an outside system's key is refused,
// so every configuration change has a verified user id in the audit trail. A change applies across
// the system on the very next request (settings are never cached).

import { send, readJsonBody } from './http.js';
import { requirePerson, auditedRead } from './clients.js';
import { ValidationError } from '../workOrders.js';
import {
  listSettings, getSettingDetail, setSetting, resetSetting, SettingVersionConflictError, SETTINGS_ADMIN,
} from '../settings.js';

export const SETTINGS_BASE = '/api/v1/settings';
export const SETTING_FIELDS = ['value'];
const ONE = new RegExp(`^${SETTINGS_BASE}/([^/]+)$`);

const etag = (version) => `"v${version}"`;

/** The version the caller last read, from If-Match. Missing → 428, malformed → 400. */
function ifMatchVersion(req, res) {
  const header = req.headers['if-match'];
  if (header === undefined || header === '') {
    send(res, 428, { error: 'precondition_required', message: 'This change needs an If-Match header with the version you last read, e.g. If-Match: "v2". Read the setting first.' });
    return null;
  }
  const m = /^(?:W\/)?"v(\d+)"$/.exec(String(header).trim());
  if (!m) throw new ValidationError(['If-Match must look like "v2" — the ETag from your last read']);
  return Number(m[1]);
}

export async function handleSettings(req, res, db, url, { key, now } = {}) {
  const opts = now ? { now } : {};
  if (url.pathname === SETTINGS_BASE) {
    if (req.method !== 'GET') {
      send(res, 405, { error: 'method_not_allowed', message: 'Use GET here' }, { Allow: 'GET' });
      return;
    }
    send(res, 200, auditedRead(db, { key, operation: 'listSettings', scope: SETTINGS_ADMIN }, () => ({ items: listSettings(db) }), opts));
    return;
  }
  const m = ONE.exec(url.pathname);
  if (!m) {
    send(res, 404, { error: 'not_found', message: `No endpoint at ${url.pathname}` });
    return;
  }
  const settingKey = decodeURIComponent(m[1]);

  if (req.method === 'GET') {
    const body = auditedRead(db, { key, operation: 'getSetting', params: { key: settingKey }, scope: SETTINGS_ADMIN },
      () => ({ item: getSettingDetail(db, settingKey) }), opts);
    send(res, 200, body, { ETag: etag(body.item.version) });
    return;
  }
  if (!['PUT', 'DELETE'].includes(req.method)) {
    send(res, 405, { error: 'method_not_allowed', message: 'Use GET, PUT or DELETE here' }, { Allow: 'GET, PUT, DELETE' });
    return;
  }

  const operation = req.method === 'PUT' ? 'setSetting' : 'resetSetting';
  const client = requirePerson(db, { key, operation, params: { key: settingKey }, scope: SETTINGS_ADMIN });
  getSettingDetail(db, settingKey); // unknown setting → 404 before anything else
  const expectedVersion = ifMatchVersion(req, res);
  if (expectedVersion === null) return;

  let body = {};
  if (req.method === 'PUT') {
    body = await readJsonBody(req);
    const problems = Object.keys(body).filter((f) => !SETTING_FIELDS.includes(f)).map((f) => `${f} is not a field this endpoint accepts`);
    if (!('value' in body)) problems.push('value is required');
    if (problems.length) throw new ValidationError(problems);
  }
  try {
    const change = { actorUserId: client.user_id, expectedVersion, ...opts };
    const { setting, changed } = req.method === 'PUT' ? setSetting(db, settingKey, body.value, change) : resetSetting(db, settingKey, change);
    send(res, 200, { item: setting, changed }, { ETag: etag(setting.version) });
  } catch (err) {
    if (!(err instanceof SettingVersionConflictError)) throw err;
    const current = getSettingDetail(db, settingKey);
    send(res, 412, { error: 'precondition_failed', message: err.message, current }, { ETag: etag(current.version) });
  }
}
