/**
 * Shared sqlite busy-retry policy — a leaf module so `hash-store` and the
 * row-family modules (e.g. `snapshot-store`) use one policy without a cycle.
 * @module dsh-better-edit/store-retry
 */

function isBusyError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const errcode = (error as { errcode?: unknown }).errcode;
    if (typeof errcode === "number") return errcode === 5 || errcode === 6;
  }
  return error instanceof Error && /busy|locked/i.test(error.message);
}

function sleepSync(ms: number): void {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

const BUSY_RETRIES = 3;
const BUSY_RETRY_DELAY_MS = 100;

export function withBusyRetry<T>(fn: () => T): T {
  let lastError: unknown;
  for (let attempt = 0; attempt <= BUSY_RETRIES; attempt++) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
      if (!isBusyError(error) || attempt === BUSY_RETRIES) throw error;
      sleepSync(BUSY_RETRY_DELAY_MS);
    }
  }
  throw lastError;
}
