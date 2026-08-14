/**
 * Truncation utilities for read output (ported from pi-coding-agent's shared
 * tool rendering): keep the head of a text payload within line and byte caps,
 * never emitting partial lines.
 * @module dsh-better-edit/truncate
 */

export const DEFAULT_MAX_LINES = 2000
export const DEFAULT_MAX_BYTES = 50 * 1024

export interface TruncationResult {
	content: string
	truncated: boolean
	truncatedBy: 'lines' | 'bytes' | null
	totalLines: number
	totalBytes: number
	outputLines: number
	outputBytes: number
	lastLinePartial: boolean
	firstLineExceedsLimit: boolean
	maxLines: number
	maxBytes: number
}

function splitLinesForCounting(content: string): string[] {
	if (content.length === 0) return []
	const lines = content.split('\n')
	if (content.endsWith('\n')) lines.pop()
	return lines
}

/** Format bytes as a human-readable size. */
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/**
 * Truncate content from the head (keep the first N lines/bytes). Suitable for
 * file reads; never returns partial lines. When the first line alone exceeds
 * the byte limit the content is emptied with `firstLineExceedsLimit`.
 */
export function truncateHead(
	content: string,
	options: { maxLines?: number; maxBytes?: number } = {},
): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
	const totalBytes = Buffer.byteLength(content, 'utf-8')
	const lines = splitLinesForCounting(content)
	const totalLines = lines.length

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		}
	}

	const firstLineBytes = Buffer.byteLength(lines[0] ?? '', 'utf-8')
	if (firstLineBytes > maxBytes) {
		return {
			content: '',
			truncated: true,
			truncatedBy: 'bytes',
			totalLines,
			totalBytes,
			outputLines: 0,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: true,
			maxLines,
			maxBytes,
		}
	}

	const outputLinesArr: string[] = []
	let outputBytesCount = 0
	let truncatedBy: 'lines' | 'bytes' = 'lines'
	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const line = lines[i]!
		const lineBytes = Buffer.byteLength(line, 'utf-8') + (i > 0 ? 1 : 0)
		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = 'bytes'
			break
		}
		outputLinesArr.push(line)
		outputBytesCount += lineBytes
	}
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = 'lines'
	}
	const outputContent = outputLinesArr.join('\n')
	const finalOutputBytes = Buffer.byteLength(outputContent, 'utf-8')
	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	}
}
