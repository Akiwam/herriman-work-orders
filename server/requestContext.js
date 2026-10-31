// Who is acting in the current request (STORY-007).
//
// When a request comes in with a personal (user) key, the API records the verified user id here
// once, after the key is checked. writeAudit reads it, so every audit entry written while handling
// that request carries the user id, without passing it through every function in between.
//
// Built on Node's AsyncLocalStorage: each request gets its own store, so two requests running at the
// same time can never see each other's user. Outside a request (tests, demos, scripts) there is no
// store and currentUserId() is null — callers can still pass actorUserId to writeAudit explicitly.

import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

/** Run fn (and everything it awaits) as one request. */
export const runRequest = (fn) => storage.run({ userId: null }, fn);

/** Record the verified user for the current request. Does nothing outside a request. */
export function setActingUser(userId) {
  const store = storage.getStore();
  if (store) store.userId = userId;
}

export const currentUserId = () => storage.getStore()?.userId ?? null;
