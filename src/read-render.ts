/**
 * Hash-anchored read rendering: turn normalized text into `HASH│content` rows
 * with pagination hints, oversized-line markers, and served-row bookkeeping.
 * Ported from pi-hashline-edit-lsz's read tool (pi APIs replaced by local
 * helpers).
 * @module dsh-better-edit/read-render
 */

import { lineHashes, fmtRegion, HASH_SEP, MAX_HASH_LINES } from './hashline/index.js'
import type { ServedRow } from './hashline/served.js'
import { visLines } from './utils.js'
import { MAX_READ_LINE_BYTES } from './constants.js'
import { formatSize, truncateHead, DEFAULT_MAX_LINES, type TruncationResult } from './truncate.js'

function normPosInt(
	value: number | undefined,
	name: 'offset' | 'limit',
): number | undefined {
	if (value === undefined) return undefined
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(
			`[E_BAD_SHAPE] Read request field "${name}" must be a positive integer.`,
		)
	}
	return value
}

export function formatPaginationHint(
	startLine: number,
	endLine: number,
	totalLines: number,
	nextOffset: number,
	byteLimit?: number,
): string {
	const sizeSuffix =
		byteLimit !== undefined ? ` (${formatSize(byteLimit)} limit)` : ''
	return `[Showing lines ${startLine}-${endLine} of ${totalLines}${sizeSuffix}. Use offset=${nextOffset} to continue.]`
}

export async function fmtReadPreview(
	text: string,
	options: { offset?: number; limit?: number },
	precomputedHashes?: string[],
	path?: string,
	maxLineBytes = MAX_READ_LINE_BYTES,
	maxTruncLines = DEFAULT_MAX_LINES,
): Promise<{
	text: string
	truncation?: TruncationResult
	nextOffset?: number
	served: ServedRow[]
}> {
	const allLines = visLines(text)
	const totalLines = allLines.length
	const startLine = normPosInt(options.offset, 'offset') ?? 1
	if (totalLines === 0) {
		if (startLine === 1) {
			const allHashes =
				precomputedHashes ??
				(await (path ? lineHashes(text, path) : lineHashes(text)))
			const emptyLineHash = allHashes[0]!
			return {
				text: `${emptyLineHash}${HASH_SEP}\n[File is empty. Use edit to insert content.]`,
				served: [{ position: 0, hash: emptyLineHash }],
			}
		}
		return {
			text: `Offset ${startLine} is beyond end of file (0 lines total). The file is empty. Use edit to insert content.`,
			served: [],
		}
	}
	if (startLine > totalLines) {
		return {
			text: `Offset ${startLine} is beyond end of file (${totalLines} lines total). Use offset=1 to read from the start, or offset=${totalLines} to read the last line.`,
			served: [],
		}
	}

	const limit = normPosInt(options.limit, 'limit')
	const endIdx = limit
		? Math.min(startLine - 1 + limit, totalLines)
		: totalLines
	const selected = allLines.slice(startLine - 1, endIdx)
	const allHashes =
		precomputedHashes ??
		(await (path ? lineHashes(text, path) : lineHashes(text)))
	const selectedHashes = allHashes.slice(startLine - 1, endIdx)
	const formatted = fmtRegion(selectedHashes, selected)
	const maxBytes = maxLineBytes
	const rowSizes = selected.map((line, index) => ({
		lineNumber: startLine + index,
		bytes: Buffer.byteLength(
			`${selectedHashes[index]}${HASH_SEP}${line}`,
			'utf-8',
		),
	}))
	if (rowSizes.some((row) => row.bytes > maxBytes)) {
		const oversized = rowSizes.filter((row) => row.bytes > maxBytes)
		const rows = rowSizes.map((row, index) =>
			row.bytes > maxBytes
				? `[Line ${row.lineNumber} is ${formatSize(row.bytes)}, exceeds ${formatSize(maxBytes)}; content not shown. Use bash: sed -n '${row.lineNumber}p' <path> | head -c ${maxBytes}]`
				: fmtRegion([selectedHashes[index]!], [selected[index]!]),
		)
		const skippedTruncation = truncateHead(rows.join('\n'), {
			maxBytes,
			maxLines: maxTruncLines,
		})
		const shownRowCount =
			skippedTruncation.content === ''
				? 0
				: skippedTruncation.content.split('\n').length
		const lastShownLine =
			shownRowCount > 0 ? startLine + shownRowCount - 1 : startLine - 1
		const lineLabel =
			oversized.length === 1
				? `Line ${oversized[0]!.lineNumber}`
				: `Lines ${oversized.map((row) => row.lineNumber).join(', ')}`
		const verb = oversized.length === 1 ? 'exceeds' : 'exceed'
		const addresses = oversized.map((row) => `${row.lineNumber}p`).join(';')
		const warning = `[${lineLabel} ${verb} ${formatSize(maxBytes)}; content not shown because hashline anchors require full lines. Inspect with bash: sed -n '${addresses}' <path> | head -c ${maxBytes}]`
		let preview = skippedTruncation.content
		let nextOffset: number | undefined
		if (
			shownRowCount > 0 &&
			(skippedTruncation.truncated || lastShownLine < totalLines)
		) {
			nextOffset = lastShownLine + 1
			preview += `\n\n${warning}\n${formatPaginationHint(startLine, lastShownLine, totalLines, nextOffset, skippedTruncation.truncated ? skippedTruncation.maxBytes : undefined)}`
		} else {
			preview += `\n\n${warning}`
		}
		const served: ServedRow[] = []
		for (let index = 0; index < shownRowCount; index++) {
			if (rowSizes[index]!.bytes <= maxBytes) {
				served.push({
					position: startLine - 1 + index,
					hash: selectedHashes[index]!,
				})
			}
		}
		return {
			text: preview,
			truncation: skippedTruncation.truncated ? skippedTruncation : undefined,
			...(nextOffset !== undefined ? { nextOffset } : {}),
			served,
		}
	}

	const truncation = truncateHead(formatted, {
		maxBytes,
		maxLines: maxTruncLines,
	})

	let preview = truncation.content
	let nextOffset: number | undefined
	if (truncation.truncated) {
		const endLineDisplay = startLine + truncation.outputLines - 1
		nextOffset = endLineDisplay + 1
		if (truncation.truncatedBy === 'lines') {
			preview += `\n\n${formatPaginationHint(startLine, endLineDisplay, totalLines, nextOffset)}`
		} else {
			preview += `\n\n${formatPaginationHint(startLine, endLineDisplay, totalLines, nextOffset, truncation.maxBytes)}`
		}
	} else if (endIdx < totalLines) {
		nextOffset = endIdx + 1
		preview += `\n\n${formatPaginationHint(startLine, endIdx, totalLines, nextOffset)}`
	}

	const served: ServedRow[] = []
	for (let index = 0; index < truncation.outputLines; index++) {
		served.push({
			position: startLine - 1 + index,
			hash: selectedHashes[index]!,
		})
	}

	return {
		text: preview,
		truncation: truncation.truncated ? truncation : undefined,
		...(nextOffset !== undefined ? { nextOffset } : {}),
		served,
	}
}

export { MAX_HASH_LINES }
