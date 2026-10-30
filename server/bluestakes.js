// The connection to the one-call centre (Blue Stakes of Utah), used to send ticket responses.
//
// Same pattern as server/gis.js: code only talks to a client made by createBlueStakesClient(),
// which adds a timeout, capped retries (none for a refused credential) and a log row per attempt.
// Behind it is a stand-in until the city has Blue Stakes access; a real adapter needs one method,
// sendResponse(ticketNumber, response, auth).

import { withTimeout, withRetry, GisError as IntegrationError } from './gis.js';

export { IntegrationError };

/** Writes one bluestakes_log row per call attempt. Pass the result to createBlueStakesClient as `log`. */
export function createBlueStakesLogger(db) {
  const insert = db.prepare(`
    INSERT INTO bluestakes_log (operation, ticket_number, attempt, outcome, error, started_at, finished_at, duration_ms)
    VALUES (:operation, :ticket_number, :attempt, :outcome, :error, :started_at, :finished_at, :duration_ms)`);
  return (entry) => insert.run(entry);
}

export function createBlueStakesClient(backend, { log, token = null, timeoutMs = 5000, attempts = 3, delayMs = 200 } = {}) {
  if (typeof log !== 'function') throw new TypeError('createBlueStakesClient needs a log function (see createBlueStakesLogger)');
  const auth = { token };

  const call = (operation, ticketNumber, fn) => withRetry(async (attempt) => {
    const started = Date.now();
    const entry = (outcome, error = null) => {
      const finished = Date.now();
      log({
        operation, ticket_number: ticketNumber, attempt, outcome, error,
        started_at: new Date(started).toISOString(), finished_at: new Date(finished).toISOString(), duration_ms: finished - started,
      });
    };
    try {
      const result = await withTimeout(fn(), timeoutMs, `Blue Stakes ${operation}(${ticketNumber})`);
      entry('ok');
      return result;
    } catch (err) {
      entry(['timeout', 'unauthorized'].includes(err?.code) ? err.code : 'error', String(err?.message ?? err));
      throw err;
    }
  }, { attempts, delayMs });

  return {
    kind: backend.kind ?? 'unknown',
    sendResponse: (ticketNumber, response) => call('sendResponse', ticketNumber, () => backend.sendResponse(ticketNumber, response, auth)),
  };
}

/**
 * In-memory stand-in for the one-call centre. Records the responses it receives, keyed by
 * response_id, so the same response delivered twice is stored once. Not the real Blue Stakes.
 */
export function createStandInBlueStakes({ requireToken = null } = {}) {
  const received = new Map();
  return {
    kind: 'stand-in',
    async sendResponse(ticketNumber, response, auth) {
      if (requireToken !== null && auth?.token !== requireToken) {
        throw new IntegrationError('Blue Stakes refused the credential (unauthorized)', { code: 'unauthorized' });
      }
      if (!received.has(response.response_id)) received.set(response.response_id, { ticket_number: ticketNumber, ...structuredClone(response) });
      return { accepted: true, response_id: response.response_id };
    },
    /** What the stand-in has received, oldest first (for tests and the demo). */
    received: () => [...received.values()].map((r) => structuredClone(r)),
  };
}
