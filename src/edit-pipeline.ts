/**
 * The single-edit pipeline shared by `edit`, previews, and (through the
 * engine) `batch_edit`: resolve → normalize → hash → verify anchors against
 * served state → apply → re-hash with stable anchors → drift notice. The
 * apply/reject/re-hash computation lives in the edit engine
 * ({@link edit-engine}); this module keeps the single-edit orchestration
 * shape, preview-mode options, and the pipeline result type. All IO goes
 * through the {@link FileIO} bridge so the same pipeline runs on `ctx.fs` and
 * on the host filesystem.
 * @module dsh-better-edit/edit-pipeline
 */

import type { HashStore } from './hash-store.js'
import type { FileIO } from './fs-bridge.js'
import { normFromText, fileSnap } from './file-reader.js'
import type { LineEnding } from './edit-diff.js'
import { toCwd } from './paths.js'
import {
	resEdit,
	MAX_HASH_LINES,
	type NEdit,
} from './hashline/index.js'
import type { ResolvedRange } from './hashline/served.js'
import {
	AnchorMismatchError,
	ServedRejectionError,
	recordEchoServes,
	type ServeRecordPolicy,
} from './hashline/served.js'
import { loadServed, sessionKeyFor } from './served-store.js'
import { scanDrift } from './drift.js'
import { abortIf, splitLines } from './utils.js'
import type { EditParams } from './contract.js'
import { applyOne } from './edit-engine.js'

export interface PipelineResult {
	path: string
	absolutePath: string
	originalNormalized: string
	result: string
	bom: string
	originalEnding: LineEnding
	hadUtf8DecodeErrors: boolean
	warnings: string[]
	noopEdit?: NEdit
	firstChangedLine?: number
	lastChangedLine?: number
	originalHashes: string[]
	resultHashes: string[]
	totalAddedLines: number
	totalRemovedLines: number
	driftNotice?: string
	range: ResolvedRange
}

export interface ExecPipelineOptions {
	signal?: AbortSignal
	store?: HashStore
	noPersist?: boolean
	sessionKey?: string
}

export async function execPipeline(
	io: FileIO,
	params: EditParams,
	cwd: string,
	options?: ExecPipelineOptions,
): Promise<PipelineResult> {
	const path = params.path

	const editWarnings: string[] = []
	// Resolve the edit up front (before IO) so malformed anchors fail before
	// any filesystem work, exactly as the tool always did.
	const edit = resEdit(
		{
			remove_from: params.remove_from,
			remove_to: params.remove_to,
			replacement_text: params.replacement_text,
		},
		editWarnings,
	)

	const hashStore = options?.store
	const signal = options?.signal

	abortIf(signal)
	const absolutePath = await io.resolve(path, cwd, signal)
	const rawText = await io.readText(absolutePath, signal)
	const {
		normalized: originalNormalized,
		bom,
		originalEnding,
		fileHashes: originalHashes,
		hadUtf8DecodeErrors,
	} = await normFromText({
		absolutePath,
		rawText,
		displayPath: path,
		signal,
		maxLines: MAX_HASH_LINES,
		store: hashStore,
		noPersist: options?.noPersist,
	})

	const sessionKey = options?.sessionKey ?? sessionKeyFor(undefined)
	const served = await loadServed(sessionKey, absolutePath)
	const policy: ServeRecordPolicy =
		options?.noPersist === true ? 'preview' : 'live'

	const applied = await applyOne(
		{
			content: originalNormalized,
			hashes: originalHashes,
			served,
			removeFrom: params.remove_from,
			removeTo: params.remove_to,
			replacementText: params.replacement_text,
			absolutePath,
			displayPath: path,
			signal,
			warnings: editWarnings,
			store: hashStore,
			persist: options?.noPersist !== true,
			edit,
		},
		async (error) => {
			if (
				error instanceof AnchorMismatchError ||
				error instanceof ServedRejectionError
			) {
				await recordEchoServes(
					sessionKey,
					absolutePath,
					error.servedRows,
					policy,
					originalHashes.length,
				)
			}
			throw error
		},
	)
	const result = applied.result
	const isNoop = applied.noop
	const warnings = [...editWarnings, ...(applied.anchorWarnings ?? [])]

	let driftNotice: string | undefined
	if (options?.noPersist !== true) {
		try {
			driftNotice = await scanDrift({
				sessionKey,
				served,
				resultHashes: applied.hashes,
				resultLines: splitLines(result),
				range: applied.range,
				path: absolutePath,
			})
		} catch (error) {
			console.error('Failed to compute drift notice:', error)
		}
	}

	return {
		path,
		absolutePath,
		originalNormalized,
		result,
		bom,
		originalEnding,
		hadUtf8DecodeErrors,
		warnings,
		noopEdit: applied.noopEdit,
		firstChangedLine: applied.firstChangedLine,
		lastChangedLine: applied.lastChangedLine,
		originalHashes,
		resultHashes: applied.hashes,
		totalAddedLines: applied.totalAddedLines,
		totalRemovedLines: applied.totalRemovedLines,
		driftNotice,
		range: applied.range,
	}
}

/** Resolve the display path a caller names against the session cwd. */
export function resolveDisplayPath(path: string, cwd: string): string {
	return toCwd(path, cwd)
}

/** Snapshot bookkeeping for noop/success results (best-effort). */
export async function snapshotIdFor(
	io: FileIO,
	absolutePath: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	try {
		return await io.statVersion(absolutePath, signal)
	} catch {
		try {
			return (await fileSnap(absolutePath)).snapshotId
		} catch {
			return undefined
		}
	}
}
