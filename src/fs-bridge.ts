/**
 * IO seam for the hashline tool layer. The tools resolve, read, and write
 * through this bridge so they honor the deployment's `ctx.fs` backend — a
 * sandboxed or remote filesystem — instead of reaching around it. The local
 * implementation exists for tests and for pure-pipeline verification.
 * @module dsh-better-edit/fs-bridge
 */

import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { resolveTarget, writeAtomic } from './fs-write.js'
import { fileSnap } from './file-reader.js'
import { toCwd } from './paths.js'

/** Text-IO operations the hashline tools need, keyed by canonical absolute path. */
export interface FileIO {
	/** Resolve a (possibly relative) request path against the session cwd to a canonical absolute path. */
	resolve(path: string, cwd: string, signal?: AbortSignal): Promise<string>
	/** Read whole text; missing files, directories, and binary content throw. */
	readText(absolutePath: string, signal?: AbortSignal): Promise<string>
	/** Atomically write whole text, preserving mode when the file exists. */
	writeText(absolutePath: string, content: string, signal?: AbortSignal): Promise<void>
	/** Opaque change-version for snapshot bookkeeping, or undefined when unavailable. */
	statVersion(absolutePath: string, signal?: AbortSignal): Promise<string | undefined>
}

/**
 * Map an `ctx.fs` failure onto the hashline model-facing vocabulary so the
 * model sees the same structured error codes as the pure pipeline.
 * @param error - the thrown FsError or any error.
 * @param displayPath - the path as the model wrote it.
 * @returns the mapped error, rethrown.
 */
export function mapFsError(error: unknown, displayPath: string): never {
	if (error instanceof Error && typeof (error as { code?: unknown }).code === 'string') {
		const code = (error as unknown as { code: string }).code
		if (code === 'FS_NOT_FOUND') {
			throw new Error(`[E_NOT_FOUND] File not found: ${displayPath}`)
		}
		if (code === 'FS_PERMISSION_DENIED') {
			throw new Error(`[E_ACCESS] Cannot access file: ${displayPath}`)
		}
		if (code === 'FS_NOT_TEXT' || code === 'FS_NOT_REGULAR_FILE') {
			throw new Error(
				`[E_NOT_TEXT] Path is not a readable UTF-8 text file: ${displayPath}. Hashline editing only supports text files.`,
			)
		}
		if (code === 'FS_ABORTED') {
			throw new Error('Operation aborted')
		}
	}
	throw error
}

/** FileIO over the deployment's `ctx.fs` service. */
export function ctxFsIO(fs: FileSystem, _ctx: Context): FileIO {
	return {
		async resolve(path, cwd, signal) {
			const target = await fs.resolve(path, {
				...(cwd !== undefined ? { cwd } : {}),
				...(signal !== undefined ? { signal } : {}),
			})
			return fs.processPath(target)
		},
		async readText(absolutePath, signal) {
			try {
				const target = await fs.resolve(absolutePath, {
					...(signal !== undefined ? { signal } : {}),
				})
				return await fs.readText(target, signal)
			} catch (error) {
				return mapFsError(error, absolutePath)
			}
		},
		async writeText(absolutePath, content, signal) {
			try {
				const target = await fs.resolve(absolutePath, {
					...(signal !== undefined ? { signal } : {}),
				})
				await fs.writeText(target, content, undefined, signal)
			} catch (error) {
				return mapFsError(error, absolutePath)
			}
		},
		async statVersion(absolutePath, signal) {
			try {
				const target = await fs.resolve(absolutePath, {
					...(signal !== undefined ? { signal } : {}),
				})
				const info = await fs.stat(target, signal)
				return info?.version ?? undefined
			} catch {
				return undefined
			}
		},
	}
}

/** FileIO over the host filesystem directly (tests, previews, fallback). */
export function localIO(): FileIO {
	return {
		async resolve(path, cwd) {
			return resolveTarget(toCwd(path, cwd ?? process.cwd()))
		},
		async readText(absolutePath, signal) {
			signal?.throwIfAborted()
			return readFile(absolutePath, 'utf-8')
		},
		async writeText(absolutePath, content, signal) {
			signal?.throwIfAborted()
			await writeAtomic(absolutePath, content)
		},
		async statVersion(absolutePath) {
			try {
				return (await fileSnap(absolutePath)).snapshotId
			} catch {
				return undefined
			}
		},
	}
}
