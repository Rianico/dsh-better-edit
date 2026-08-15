/**
 * The single-edit pipeline shared by `edit`, `batch_edit`, and previews:
 * resolve → normalize → hash → verify anchors against served state → apply →
 * re-hash with stable anchors → drift notice. All IO goes through the
 * {@link FileIO} bridge so the same pipeline runs on `ctx.fs` and on the host
 * filesystem.
 * @module dsh-better-edit/edit-pipeline
 */

import type { HashStore } from './hash-store.js'
import type { FileIO } from './fs-bridge.js'
import { normFromText, fileSnap } from './file-reader.js'
import type { LineEnding } from './edit-diff.js'
import { toCwd } from './paths.js'
import {
	applyEdit,
	lineHashes,
	resEdit,
	parseHashRef,
	MAX_HASH_LINES,
	type HEdit,
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
import { findSnapshotPathsByHashes } from './snapshot-store.js'
import { scanDrift } from './drift.js'
import { abortIf, isRec, rejectUnknownFields, splitLines } from './utils.js'
import type { EditParams } from './schema.js'

const ROOT_KS = new Set(['path', 'remove_from', 'remove_to', 'replacement_text', 'sandbox_permissions', 'justification'])

export function assertReq(request: unknown): asserts request is EditParams {
	if (!isRec(request)) {
		throw new Error('[E_BAD_SHAPE] Edit request must be an object.')
	}

	rejectUnknownFields(request, ROOT_KS, 'Edit request')

	if (typeof request.path !== 'string' || request.path.length === 0) {
		throw new Error(
			'[E_BAD_SHAPE] Edit request requires a non-empty "path" string.',
		)
	}

	if (
		typeof request.remove_from !== 'string' ||
		typeof request.remove_to !== 'string' ||
		typeof request.replacement_text !== 'string'
	) {
		throw new Error(
			'[E_BAD_SHAPE] Edit request requires "remove_from", "remove_to", and "replacement_text" at the top level.',
		)
	}
}

export async function resolveMissingPath(
	request: Record<string, unknown>,
): Promise<{ path: string; warning: string } | undefined> {
	if (typeof request.path === 'string') return undefined
	const from = request.remove_from
	const to = request.remove_to
	if (typeof from !== 'string' || typeof to !== 'string') return undefined
	const hashes: string[] = []
	for (const ref of [from, to]) {
		try {
			hashes.push(parseHashRef(ref).hash)
		} catch {
			return undefined
		}
	}
	let matches: string[]
	try {
		matches = await findSnapshotPathsByHashes(hashes)
	} catch {
		return undefined
	}
	if (matches.length === 1) {
		return {
			path: matches[0]!,
			warning: `[E_BAD_SHAPE] Autocorrected: missing "path" resolved to ${matches[0]} — the only file whose stored hashes contain both anchors.`,
		}
	}
	if (matches.length > 1) {
		throw new Error(
			`[E_BAD_SHAPE] Edit request requires a non-empty "path" string; the anchors match multiple known files: ${matches.join(', ')}. Include the intended path.`,
		)
	}
	return undefined
}

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

export function collectRemovedHashes(
	edit: HEdit,
	originalHashes: string[],
): Set<string> {
	const removedHashes = new Set<string>()
	const startHash = edit.hash_bounds[0].hash
	const endHash = edit.hash_bounds[1].hash
	const startLine = originalHashes.indexOf(startHash)
	const endLine = originalHashes.indexOf(endHash)
	if (startLine >= 0 && endLine >= 0) {
		const firstLine = Math.min(startLine, endLine)
		const lastLine = Math.max(startLine, endLine)
		for (let i = firstLine; i <= lastLine; i++) {
			removedHashes.add(originalHashes[i]!)
		}
	}
	return removedHashes
}

export function countLineChanges(
	edit: HEdit,
	originalHashes: string[],
	isNoop: boolean,
	removedAutoFixes: number,
): { totalAddedLines: number; totalRemovedLines: number } {
	if (isNoop) return { totalAddedLines: 0, totalRemovedLines: 0 }
	let totalRemovedLines = 0
	const startLine = originalHashes.indexOf(edit.hash_bounds[0].hash)
	const endLine = originalHashes.indexOf(edit.hash_bounds[1].hash)
	if (startLine >= 0 && endLine >= 0) {
		totalRemovedLines = Math.abs(endLine - startLine) + 1
	}
	return {
		totalAddedLines: Math.max(0, edit.content_lines.length - removedAutoFixes),
		totalRemovedLines,
	}
}

export async function execPipeline(
	io: FileIO,
	params: EditParams,
	cwd: string,
	options?: ExecPipelineOptions,
): Promise<PipelineResult> {
	const path = params.path

	const editWarnings: string[] = []
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

	let anchorResult: ReturnType<typeof applyEdit>
	try {
		anchorResult = applyEdit(
			originalNormalized,
			edit,
			signal,
			originalHashes,
			path,
			served,
		)
	} catch (error) {
		if (
			error instanceof AnchorMismatchError ||
			error instanceof ServedRejectionError
		) {
			await recordEchoServes(sessionKey, absolutePath, error.servedRows, policy, originalHashes.length)
		}
		throw error
	}
	const result = anchorResult.content
	const isNoop = result === originalNormalized

	const noPersist = options?.noPersist
	const removedHashes = isNoop
		? undefined
		: collectRemovedHashes(edit, originalHashes)
	const resultHashes = isNoop
		? originalHashes
		: await lineHashes(
				result,
				absolutePath,
				{
					content: originalNormalized,
					hashes: originalHashes,
					removedHashes,
				},
				hashStore,
				noPersist !== true,
			)
	const warnings = [...editWarnings, ...(anchorResult.warnings ?? [])]
	const { totalAddedLines, totalRemovedLines } = countLineChanges(
		edit,
		originalHashes,
		isNoop,
		anchorResult.autoFixes?.length ?? 0,
	)

	let driftNotice: string | undefined
	if (options?.noPersist !== true) {
		try {
			driftNotice = await scanDrift({
				sessionKey,
				served,
				resultHashes,
				resultLines: splitLines(result),
				range: anchorResult.range,
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
		noopEdit: anchorResult.noopEdit,
		firstChangedLine: anchorResult.firstChangedLine,
		lastChangedLine: anchorResult.lastChangedLine,
		resultHashes,
		originalHashes,
		totalAddedLines,
		totalRemovedLines,
		driftNotice,
		range: anchorResult.range,
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
