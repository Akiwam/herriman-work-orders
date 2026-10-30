// Small, DOM-free helpers shared by every tab.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape any value for safe insertion into HTML. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Parse a plan date ("YYYY-MM-DD") as a local calendar day. Returns null for anything else. */
export function parseDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** "20 Sep 2026", or null when the plan has no date. */
export function fmtDay(value) {
  const d = parseDay(value);
  return d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null;
}

/** Whole calendar days from today to the given plan date (negative = in the past). */
export function daysFromToday(value, now = Date.now()) {
  const d = parseDay(value);
  if (!d) return null;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return Math.round((d - today) / DAY_MS);
}

/** "today", "in 3 days", "12 days ago". */
export function relDays(n) {
  if (n === null || n === undefined) return '';
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}

function relAge(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export const STALE_AFTER_MS = 7 * DAY_MS;

/**
 * How old the data is, from manifest.generated_at.
 * level: 'fresh' (< 1 day), 'ok' (1–7 days), 'stale' (> 7 days) or 'unknown'.
 */
export function freshness(generatedAt, now = Date.now()) {
  const when = generatedAt ? new Date(generatedAt) : null;
  if (!when || Number.isNaN(when.getTime())) {
    return { level: 'unknown', text: 'Data age unknown — manifest.json has no generated_at. Sync from the portal to refresh.' };
  }
  const ageMs = Math.max(0, now - when.getTime());
  const absolute = when.toLocaleString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const text = `Data as of ${absolute} (${relAge(ageMs)})`;
  if (ageMs > STALE_AFTER_MS) {
    return { level: 'stale', ageMs, text: `${text} — over a week old. Sync from the portal to refresh.` };
  }
  return { level: ageMs < DAY_MS ? 'fresh' : 'ok', ageMs, text };
}
