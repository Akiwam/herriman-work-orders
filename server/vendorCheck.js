// Vendor conformance check (STORY-009, REQ-054): "API specifications and testing would need to be
// coordinated with the specific vendors." This is the test a vendor (or the city) runs against a test
// copy of the system to prove a feed works before sign-off.
//
// It checks, for one vendor:
//   1. the vendor and its contract are published;
//   2. the feed answers with the vendor's own key, and refuses no key;
//   3. every record on every page matches the published contract;
//   4. paging never repeats a record, and the saved cursor resumes with nothing new.
//
// Every call has a timeout and a capped number of attempts. Only timeouts, network errors and 5xx
// answers are retried; a refused key (401/403) or a bad request (4xx) is never retried. The key is
// sent only in the Authorization header and never appears in the report.

import { validateForVendor } from './vendors.js';

const MAX_ATTEMPTS = 5;
const MAX_PAGES = 1000; // a feed that never ends is a failure, not an endless loop

class RetryableError extends Error {}

/** GET a JSON URL with a timeout and capped retries. Returns { status, body }. */
async function getJson(url, { key, timeoutMs, attempts, fetchImpl, wait }) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetchImpl(url, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status >= 500) throw new RetryableError(`server answered ${res.status}`);
      return { status: res.status, body: await res.json().catch(() => null) };
    } catch (err) {
      lastError = err.name === 'TimeoutError' ? new Error(`no answer within ${timeoutMs} ms`) : err;
      if (attempt < attempts) await wait(attempt * 200);
    }
  }
  throw new Error(`${lastError.message} (after ${attempts} attempt${attempts > 1 ? 's' : ''})`);
}

/**
 * Run every check for one vendor. Never throws for a failed check: each check is reported as
 * passed or failed with a reason, so a vendor sees everything that needs fixing in one run.
 */
export async function runVendorCheck({
  baseUrl, vendor, key, timeoutMs = 5000, attempts = 3, pageSize = 50,
  fetchImpl = globalThis.fetch, wait = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const tries = Math.min(Math.max(1, Number(attempts) || 1), MAX_ATTEMPTS);
  const opts = { timeoutMs, attempts: tries, fetchImpl, wait };
  const api = `${String(baseUrl).replace(/\/+$/, '')}/api/v1`;
  const checks = [];
  const record = (name, passed, detail) => checks.push({ name, passed, detail });

  // 1. Published contract
  let contract = null;
  try {
    const { status, body } = await getJson(`${api}/vendors`, opts);
    contract = body?.items?.find((v) => v.key === vendor)?.contracts?.at(-1) ?? null;
    record('contract published', status === 200 && Boolean(contract),
      contract ? `contract version ${contract.version} (${contract.status}), ${contract.fields.length} fields` : `no published contract for ${vendor} (status ${status})`);
  } catch (err) {
    record('contract published', false, err.message);
  }

  // 2. Access: no key is refused, the vendor's key is accepted
  try {
    const { status } = await getJson(`${api}/vendors/${encodeURIComponent(vendor)}/feed?limit=1`, { ...opts, key: null });
    record('refuses requests without a key', status === 401, `answered ${status} without a key`);
  } catch (err) {
    record('refuses requests without a key', false, err.message);
  }

  // 3 + 4. Read every page with the key, check every record, then resume from the saved cursor
  const seen = new Set();
  let cursor = '';
  let pages = 0;
  let mismatches = [];
  let repeats = 0;
  try {
    let more = true;
    while (more && pages < MAX_PAGES) {
      const { status, body } = await getJson(`${api}/vendors/${encodeURIComponent(vendor)}/feed?limit=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { ...opts, key });
      if (status !== 200) {
        record('feed answers with the vendor key', false, `answered ${status}${body?.message ? `: ${body.message}` : ''}`);
        return { passed: false, vendor, checks };
      }
      pages += 1;
      for (const [i, item] of (body.items ?? []).entries()) {
        if (seen.has(item.id)) repeats += 1;
        seen.add(item.id);
        mismatches.push(...validateForVendor(vendor, body.contract_version, item, `page ${pages} item ${i}`));
      }
      cursor = body.next_cursor;
      more = body.has_more === true;
    }
    record('feed answers with the vendor key', true, `${seen.size} record(s) in ${pages} page(s)`);
    mismatches = mismatches.slice(0, 20);
    record('every record matches the contract', mismatches.length === 0, mismatches.length ? mismatches.join('; ') : 'all records match');
    record('paging never repeats a record', repeats === 0 && pages < MAX_PAGES, repeats ? `${repeats} record(s) repeated` : (pages >= MAX_PAGES ? 'the feed did not end' : 'no repeats'));

    const resumed = await getJson(`${api}/vendors/${encodeURIComponent(vendor)}/feed?limit=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { ...opts, key });
    const ok = resumed.status === 200 && resumed.body.items.length === 0 && resumed.body.next_cursor === cursor;
    record('the saved cursor resumes with nothing new', ok, ok ? 'resumed at the same position' : `resuming returned ${resumed.body?.items?.length ?? resumed.status} record(s)`);
  } catch (err) {
    record('feed answers with the vendor key', false, err.message);
  }

  return { passed: checks.every((c) => c.passed), vendor, checks };
}

/** The report as text, for the terminal. Contains no key. */
export function formatReport(report) {
  const lines = [`Vendor conformance check: ${report.vendor} — ${report.passed ? 'PASSED' : 'FAILED'}`];
  for (const c of report.checks) lines.push(`  ${c.passed ? 'PASS' : 'FAIL'}  ${c.name}: ${c.detail}`);
  return lines.join('\n');
}
