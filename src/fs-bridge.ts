/**
 * IO seam for the hashline tool layer. The tools resolve, read, and write
 * through this bridge so they honor the deployment's `ctx.fs` backend — a
 * sandboxed or remote filesystem — instead of reaching around it.
 *
 * The bridge also participates in dsh's `fs/*` event gate exactly like the
 * built-in tools: writes dispatch `fs/write-intent` (so the observation policy
 * derives its create/replace guard and stale-version checks) and every
 * successful read/mutation emits `fs/observed` with the resulting version. A
 * hashline tool that silently skipped those events would leave the policy's
 * observed state stale, and the next built-in `write` on the same file would
 * fail with `FS_NOT_OBSERVED` / `FS_STALE_VERSION`.
 *
 * The local implementation exists for tests and pure-pipeline verification.
 * @module dsh-better-edit/fs-bridge
 */

import { readFile } from "node:fs/promises";
import type { Context } from "@deepseek-ai/cordis";
import type { FileSystem, FsTarget } from "@deepseek-ai/dsh-fs";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import { writeAtomic } from "./fs-write.js";
import { fileSnap } from "./file-reader.js";
import { resolveTarget, toCwd } from "./paths.js";

/** Text-IO operations the hashline tools need, keyed by canonical absolute path. */
export interface FileIO {
	/** Resolve a (possibly relative) request path against the session cwd to a canonical absolute path. */
	resolve(path: string, cwd: string, signal?: AbortSignal): Promise<string>;
	/** Read whole text; missing files, directories, and binary content throw. */
	readText(absolutePath: string, signal?: AbortSignal): Promise<string>;
	/**
	 * Atomically write whole text, preserving mode when the file exists. On the
	 * dsh backend this dispatches `fs/write-intent` (policy guard), stamps the
	 * sandbox policy (session workspace root + mode) onto the write, and emits
	 * `fs/observed` with the new version on success, so later built-in tools
	 * see a fresh observation.
	 * @param exec - the calling execution; carries the session the policy keys by.
	 * @param sandboxPolicy - the per-call sandbox mode + workspace root the
	 *   confined backend checks (resolved from the session by the tool layer);
	 *   omitted on an unsandboxed backend.
	 */
	writeText(
		absolutePath: string,
		content: string,
		signal?: AbortSignal,
		exec?: ToolExecution,
		sandboxPolicy?: SandboxExecutionPolicy,
	): Promise<void>;
	/**
	 * Emit `fs/observed` (present at the current version) for a successful
	 * read, so the policy records that this session has seen the file.
	 * @param exec - the calling execution; carries the session the policy keys by.
	 */
	emitObserved(
		absolutePath: string,
		exec?: ToolExecution,
		signal?: AbortSignal,
	): Promise<void>;
	/** Opaque change-version for snapshot bookkeeping, or undefined when unavailable. */
	statVersion(
		absolutePath: string,
		signal?: AbortSignal,
	): Promise<string | undefined>;
}

/**
 * Map an `ctx.fs` failure onto the hashline model-facing vocabulary so the
 * model sees the same structured error codes as the pure pipeline.
 * @param error - the thrown FsError or any error.
 * @param displayPath - the path as the model wrote it.
 * @returns the mapped error, rethrown.
 */
export function mapFsError(error: unknown, displayPath: string): never {
	if (
		error instanceof Error &&
		typeof (error as { code?: unknown }).code === "string"
	) {
		const code = (error as unknown as { code: string }).code;
		if (code === "FS_NOT_FOUND") {
			throw new Error(`[E_NOT_FOUND] File not found: ${displayPath}`);
		}
		if (code === "FS_PERMISSION_DENIED") {
			throw new Error(`[E_ACCESS] Cannot access file: ${displayPath}`);
		}
		if (code === "FS_NOT_TEXT" || code === "FS_NOT_REGULAR_FILE") {
			throw new Error(
				`[E_NOT_TEXT] Path is not a readable UTF-8 text file: ${displayPath}. Hashline editing only supports text files.`,
			);
		}
		if (code === "FS_STALE_VERSION") {
			throw new Error(
				`[E_RANGE_STALE] The file changed on disk since it was read (version guard rejected the write). Call read() to get fresh anchors, then retry.`,
			);
		}
		if (code === "FS_NOT_OBSERVED") {
			throw new Error(
				`[E_NOT_OBSERVED] The file has not been observed in this session (read-before-write policy). Call read() first, then retry the edit.`,
			);
		}
		if (code === "FS_ABORTED") {
			throw new Error("Operation aborted");
		}
	}
	throw error;
}

const UTF8_BOM = "\uFEFF";
const UTF8_BOM_BYTES = [0xef, 0xbb, 0xbf] as const;
const UTF8_BOM_LEN = UTF8_BOM_BYTES.length;

/**
 * Restore a UTF-8 BOM consumed by a backend's {@link TextDecoder}. The raw
 * byte seam reads whole files rather than prefixes, so first use stat size to
 * narrow the expensive probe to the only possible BOM case: exactly three
 * storage bytes are missing from the decoded UTF-8 representation.
 *
 * Compensation for upstream BOM stripping: `dsh-fs-local` decodes with
 * `TextDecoder("utf-8",{fatal:true})` (`ignoreBOM:false` by default) and
 * swallows leading `EF BB BF`.
 * https://github.com/deepseek-ai/deepseek-harness/discussions/1026
 * https://github.com/Rianico/dsh-better-edit/issues/23
 */
async function restoreStrippedUtf8Bom(
	fs: FileSystem,
	target: FsTarget,
	text: string,
	signal?: AbortSignal,
): Promise<string> {
	if (text.startsWith(UTF8_BOM)) return text;

	const info = await fs.stat(target, signal);
	if (
		info?.size === undefined ||
		info.size !== Buffer.byteLength(text, "utf-8") + UTF8_BOM_LEN
	) {
		return text;
	}

	const bytes = await fs.readBytes(target, signal, info.size);
	const encodedText = Buffer.from(text, "utf-8");
	if (
		bytes.length !== encodedText.length + UTF8_BOM_LEN ||
		bytes[0] !== UTF8_BOM_BYTES[0] ||
		bytes[1] !== UTF8_BOM_BYTES[1] ||
		bytes[2] !== UTF8_BOM_BYTES[2]
	) {
		return text;
	}
	for (let i = 0; i < encodedText.length; i += 1) {
		if (bytes[i + UTF8_BOM_LEN] !== encodedText[i]) return text;
	}
	return `${UTF8_BOM}${text}`;
}

/** FileIO over the deployment's `ctx.fs` service. */
export function ctxFsIO(fs: FileSystem, ctx: Context): FileIO {
	return {
		async resolve(path, cwd, signal) {
			const target = await fs.resolve(path, {
				...(cwd !== undefined ? { cwd } : {}),
				...(signal !== undefined ? { signal } : {}),
			});
			return fs.processPath(target);
		},
		async readText(absolutePath, signal) {
			try {
				const target = await fs.resolve(absolutePath, {
					...(signal !== undefined ? { signal } : {}),
				});
				const text = await fs.readText(target, signal);
				return await restoreStrippedUtf8Bom(fs, target, text, signal);
			} catch (error) {
				return mapFsError(error, absolutePath);
			}
		},
		async writeText(absolutePath, content, signal, exec, sandboxPolicy) {
			try {
				const target = await fs.resolve(absolutePath, {
					...(signal !== undefined ? { signal } : {}),
				});
				// Single-slot decision: the observation policy produces
				// createIfAbsent / replaceIfVersion; the bare default is
				// undefined (unconditional) when no policy is mounted.
				const intent = await ctx.waterfall(
					"fs/write-intent",
					target,
					exec,
					() => undefined,
				);
				// The sandbox policy (session workspace root + mode) is what a
				// confined backend checks: without it the backend falls back to
				// the deployment default root and denies writes inside the
				// session workspace under workspace-write.
				const outcome = await fs.writeText(
					target,
					content,
					intent,
					signal,
					sandboxPolicy,
				);
				// Record the present observation (a no-op when no policy
				// plugin listens), so later built-in tools see the new version.
				ctx.emit(
					"fs/observed",
					target,
					{ kind: "present", version: outcome.version },
					exec,
				);
			} catch (error) {
				// FS_SANDBOX_DENIED passes through raw; the tool layer maps it
				// to the shared [sandbox: …] marker + escalation hint via its
				// sandbox controller.
				return mapFsError(error, absolutePath);
			}
		},
		async emitObserved(absolutePath, exec, signal) {
			try {
				const target = await fs.resolve(absolutePath, {
					...(signal !== undefined ? { signal } : {}),
				});
				const info = await fs.stat(target, signal);
				if (info !== undefined) {
					ctx.emit(
						"fs/observed",
						target,
						{ kind: "present", version: info.version },
						exec,
					);
				}
			} catch (error) {
				// A failed observation must not fail the read that preceded it.
				console.error(
					`dsh-better-edit: fs/observed emission failed for ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},
		async statVersion(absolutePath, signal) {
			try {
				const target = await fs.resolve(absolutePath, {
					...(signal !== undefined ? { signal } : {}),
				});
				const info = await fs.stat(target, signal);
				return info?.version ?? undefined;
			} catch {
				return undefined;
			}
		},
	};
}

/** FileIO over the host filesystem directly (tests, previews, fallback). */
export function localIO(): FileIO {
	return {
		async resolve(path, cwd) {
			return resolveTarget(toCwd(path, cwd ?? process.cwd()));
		},
		async readText(absolutePath, signal) {
			signal?.throwIfAborted();
			return readFile(absolutePath, "utf-8");
		},
		async writeText(absolutePath, content, signal, _exec, _sandboxPolicy) {
			signal?.throwIfAborted();
			await writeAtomic(absolutePath, content);
		},
		async emitObserved() {
			// No policy event gate on the host filesystem; nothing to record.
		},
		async statVersion(absolutePath) {
			try {
				return (await fileSnap(absolutePath)).snapshotId;
			} catch {
				return undefined;
			}
		},
	};
}
