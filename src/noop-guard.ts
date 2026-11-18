type NoopLoopEntry = {
  payload: string;
  count: number;
};

/**
 * The noop-loop counters, keyed by `(session, file)` identity (ADR-0039).
 *
 * WHY the session in the key: a counter keyed by the file alone is shared state
 * across sessions, so one session's repeats advance another session's count —
 * and at `NOOP_LOOP_THRESHOLD` the second session's FIRST submission of an
 * unchanged edit was refused for a loop it never ran (measured pre-fix:
 * session-A=1, session-A=2, session-B=3). The loop is a property of what a
 * session keeps resubmitting, not of the file.
 *
 * The key is an IDENTITY, not a second copy of the payload: the payload
 * (`noopPayloadKey`) already carries the absolute path as its first element, so
 * the entry's `payload` equality check is scoped by the same file the key names.
 */
const noopLoopTracker = new Map<string, NoopLoopEntry>();

/** Tracker identity: one counter per `(session, file)` pair. */
function trackerKey(sessionKey: string, absolutePath: string): string {
  return JSON.stringify([sessionKey, absolutePath]);
}

export function noopPayloadKey(
  absolutePath: string,
  anchorFrom: string,
  anchorTo: string,
  replaceWith: string,
): string {
  return JSON.stringify([absolutePath, anchorFrom, anchorTo, replaceWith]);
}

export function trackNoopPayload(
  sessionKey: string,
  absolutePath: string,
  payload: string,
): number {
  const key = trackerKey(sessionKey, absolutePath);
  const existing = noopLoopTracker.get(key);
  const count = existing && existing.payload === payload ? existing.count + 1 : 1;
  noopLoopTracker.set(key, { payload, count });
  return count;
}

export function clearNoopLoop(sessionKey: string, absolutePath: string): void {
  noopLoopTracker.delete(trackerKey(sessionKey, absolutePath));
}
