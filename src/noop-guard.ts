import { formatError, formatWarning } from "./domain-errors.js";
import { NOOP_LOOP_THRESHOLD } from "./constants.js";

type NoopLoopEntry = {
  payload: string;
  count: number;
};

const noopLoopTracker = new Map<string, NoopLoopEntry>();

export function noopPayloadKey(
  absolutePath: string,
  removeFrom: string,
  removeTo: string,
  replacementText: string,
): string {
  return JSON.stringify([absolutePath, removeFrom, removeTo, replacementText]);
}

export function trackNoopPayload(absolutePath: string, payload: string): number {
  const existing = noopLoopTracker.get(absolutePath);
  const count = existing && existing.payload === payload ? existing.count + 1 : 1;
  noopLoopTracker.set(absolutePath, { payload, count });
  return count;
}

export function clearNoopLoop(absolutePath: string): void {
  noopLoopTracker.delete(absolutePath);
}

export { NOOP_LOOP_THRESHOLD };

// Shared noop-loop policy folded from edit-pipeline (ARCH C2)
// Keeps trackNoopPayload as primitive but exposes warn/reject decisions.
export interface NoopPolicyInput {
  absolutePath: string;
  removeFrom: string;
  removeTo: string;
  replacementText: string;
  ref: string;
  batch: boolean;
  range: { startLine: number; endLine: number };
  hashes: string[];
  lines: string[];
  sessionKey: string;
}

export type NoopPolicyOutcome =
  | { action: "proceed"; count: number }
  | { action: "warn"; count: number; notice: string }
  | { action: "reject"; count: number; message: string };

export function runNoopPolicySync(input: NoopPolicyInput, count: number): NoopPolicyOutcome {
  if (count >= NOOP_LOOP_THRESHOLD) {
    const message = formatError("E_NOOP_LOOP", {
      ref: input.ref,
      removeFrom: input.removeFrom,
      removeTo: input.removeTo,
      count,
      batch: input.batch,
      servedBlock: "",
    });
    return { action: "reject", count, message };
  }
  if (count === 2) {
    // Channel rule: applied-tier notices are human-observable → USER audience via the registry.
    const notice = formatWarning("W_NOOP", {
      ref: input.ref,
      removeFrom: input.removeFrom,
      removeTo: input.removeTo,
      batch: input.batch,
      count,
    });
    return { action: "warn", count, notice };
  }
  return { action: "proceed", count };
}

export async function runNoopPolicy(input: NoopPolicyInput): Promise<NoopPolicyOutcome> {
  const payload = noopPayloadKey(
    input.absolutePath,
    input.removeFrom,
    input.removeTo,
    input.replacementText,
  );
  const count = trackNoopPayload(input.absolutePath, payload);
  return runNoopPolicySync(input, count);
}
