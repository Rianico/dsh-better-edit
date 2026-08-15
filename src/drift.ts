import { SERVED_ECHO_CAP } from "./constants.js";
import {
	type ServedRow,
	fmtServedRows,
	type ResolvedRange,
} from "./hashline/served.js";
import {
	currentPositionOfDrifted,
	driftReported,
	markDriftReported,
	recordServed,
	servedPositionsOf,
} from "./served-state.js";

export const DRIFT_NOTICE_HEADING = "Drift notice:";

export interface DriftRow extends ServedRow {
	content: string;
	drifted: boolean;
}

export interface ComputeDriftInput {
	served: (string | null)[];
	resultHashes: string[];
	resultLines: string[];
	range: ResolvedRange;
	reported: Set<string>;
	cap?: number;
}

export interface DriftNoticeResult {
	text: string;
	rows: DriftRow[];
	total: number;
	allAlreadyReported: boolean;
}

export function computeDrift(
	input: ComputeDriftInput,
): DriftNoticeResult | undefined {
	const {
		served,
		resultHashes,
		resultLines,
		range,
		reported,
		cap = SERVED_ECHO_CAP,
	} = input;

	const resultHashSet = new Set(resultHashes);
	const currentPosOfHash = new Map<string, number>();
	for (let i = 0; i < resultHashes.length; i++) {
		currentPosOfHash.set(resultHashes[i]!, i);
	}

	const startPositions = servedPositionsOf(served, range.startHash);
	const endPositions = servedPositionsOf(served, range.endHash);
	let servedStartIdx: number;
	let servedEndIdx: number;
	if (startPositions.length === 1 && endPositions.length === 1) {
		servedStartIdx = startPositions[0]!;
		servedEndIdx = endPositions[0]!;
	} else {
		servedStartIdx = range.startLine - 1;
		servedEndIdx = range.endLine - 1;
	}
	const rangeFrom = Math.min(servedStartIdx, servedEndIdx);
	const rangeTo = Math.max(servedStartIdx, servedEndIdx);

	let total = 0;
	let unshown = 0;
	let anyNotReported = false;
	const driftedPositions: number[] = [];

	for (let p = 0; p < served.length; p++) {
		const servedHash = served[p];
		if (servedHash === null) continue;
		if (p >= rangeFrom && p <= rangeTo) continue;
		if (resultHashSet.has(servedHash)) continue;
		total++;
		if (!reported.has(servedHash)) anyNotReported = true;
		const currentPos = currentPositionOfDrifted(
			served,
			currentPosOfHash,
			resultHashSet,
			p,
			range.delta,
		);
		if (
			currentPos >= 0 &&
			currentPos < resultHashes.length &&
			currentPos < resultLines.length
		) {
			driftedPositions.push(currentPos);
		} else {
			unshown++;
		}
	}

	if (total === 0) return undefined;

	const countLabel = `${total} line(s)`;
	if (!anyNotReported) {
		return {
			text: `${DRIFT_NOTICE_HEADING} ${countLabel} outside the edited range drifted and were already reported — call read to refresh.`,
			rows: [],
			total,
			allAlreadyReported: true,
		};
	}

	const driftedSet = new Set(driftedPositions);
	const windowSet = new Set<number>();
	for (const pos of driftedPositions) {
		for (const w of [pos - 1, pos, pos + 1]) {
			if (w >= 0 && w < resultLines.length) windowSet.add(w);
		}
	}
	const windowPositions = [...windowSet].sort((a, b) => a - b);
	const shownPositions = windowPositions.slice(0, cap);
	unshown += windowPositions.length - shownPositions.length;

	const rows: DriftRow[] = shownPositions.map((position) => ({
		position,
		hash: resultHashes[position]!,
		content: resultLines[position]!,
		drifted: driftedSet.has(position),
	}));

	const rowsText = fmtServedRows(rows, resultLines);
	const moreText =
		unshown > 0
			? `\n[... ${unshown} more line(s) — call read to see them]`
			: "";
	return {
		text: `${DRIFT_NOTICE_HEADING} ${countLabel} outside the edited range drifted. Current content around the drift:\n${rowsText}${moreText}`,
		rows,
		total,
		allAlreadyReported: false,
	};
}

export async function scanDrift(input: {
	sessionKey: string;
	served: (string | null)[];
	resultHashes: string[];
	resultLines: string[];
	range: ResolvedRange;
	path: string;
}): Promise<string | undefined> {
	const reported = await driftReported(input.sessionKey, input.path);
	const result = computeDrift({ ...input, reported });
	if (!result || result.allAlreadyReported) return result?.text;
	await recordServed(
		input.sessionKey,
		input.path,
		result.rows.map((row) => ({ position: row.position, hash: row.hash })),
		input.resultLines.length,
	);
	await markDriftReported(
		input.sessionKey,
		input.path,
		result.rows.filter((row) => row.drifted).map((row) => row.hash),
	);
	return result.text;
}
