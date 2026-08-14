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

export function trackNoopPayload(
	absolutePath: string,
	payload: string,
): number {
	const existing = noopLoopTracker.get(absolutePath);
	const count =
		existing && existing.payload === payload ? existing.count + 1 : 1;
	noopLoopTracker.set(absolutePath, { payload, count });
	return count;
}

export function clearNoopLoop(absolutePath: string): void {
	noopLoopTracker.delete(absolutePath);
}

export { NOOP_LOOP_THRESHOLD };
