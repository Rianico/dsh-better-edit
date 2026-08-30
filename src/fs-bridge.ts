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
import { loadConfig } from "./store-config.js";
import { detectBom, isValidUtf8, decodeBytes, encodeText, normalizeEncoding, top3Candidates, isSupportedEncoding, detectWithChardet, chardetTop3Candidates, getTop3Candidates } from "./encoding.js";
import { fileSnap } from "./file-reader.js";
import { resolveTarget, toCwd } from "./paths.js";

/** Text-IO operations the hashline tools need, keyed by canonical absolute path. */
export interface FileIO {
	/** Resolve a (possibly relative) request path against the session cwd to a canonical absolute path. */
	resolve(path: string, cwd: string, signal?: AbortSignal): Promise<string>;
	/** Read whole text; missing files, directories, and binary content throw. */
	readText(absolutePath: string, signal?: AbortSignal, encoding?: string): Promise<string>;
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
		// SAFETY: `error` narrowed to Error with string `code` above — typed extraction for FS code switch
		const code = (error as unknown as { code: string }).code;
		if (code === "FS_NOT_FOUND") {
			throw new Error(`[E_NOT_FOUND] File not found: ${displayPath}`);
		}
		if (code === "FS_PERMISSION_DENIED") {
			throw new Error(`[E_ACCESS] Cannot access file: ${displayPath}`);
		}
		if (code === "FS_NOT_TEXT" || code === "FS_NOT_REGULAR_FILE") {
			throw new Error(
				`[E_NOT_TEXT] Path is not a readable UTF-8 text file: ${displayPath}. Hashline editing only supports text files. Try read({encoding: "gbk"}) or enable autoGuessEncoding.`,
			);
		}
		if (code === "FS_BAD_ENCODING") {
			throw new Error(`[E_BAD_ENCODING] Unknown encoding for ${displayPath}. Supported: utf8, gbk, big5, shift_jis, euc-kr, windows-1251, iso-8859-1`);
		}
		if (code === "FS_DECODE_FAILED") {
			throw new Error(`[E_DECODE_FAILED] Bytes in ${displayPath} cannot be decoded with requested encoding.`);
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

// ---- file encoding state fallback (session-TTL, version-invalidated) ----
export interface FileEncodingState {
	encoding: string;
	hasBOM: boolean;
	version: string | undefined;
}
const encodingMemo = new Map<string, FileEncodingState>();
const autoGuessFooterMemo = new Map<string, string>();
export function getAutoGuessFooter(targetKey: string): string | undefined {
	return autoGuessFooterMemo.get(targetKey);
}
export function setAutoGuessFooter(targetKey: string, footer: string): void {
	autoGuessFooterMemo.set(targetKey, footer);
}
export function clearAutoGuessFooter(targetKey?: string): void {
	if (targetKey) autoGuessFooterMemo.delete(targetKey);
	else autoGuessFooterMemo.clear();
}

export function getEncodingState(targetKey: string): FileEncodingState | undefined {
	return encodingMemo.get(targetKey);
}
export function setEncodingState(targetKey: string, state: FileEncodingState): void {
	encodingMemo.set(targetKey, state);
}
export function clearEncodingState(targetKey?: string): void {
	if (targetKey) encodingMemo.delete(targetKey);
	else encodingMemo.clear();
}
function isFsNotText(error: unknown): boolean {
	return error instanceof Error && typeof (error as { code?: unknown }).code === "string" && ((error as unknown as { code: string }).code === "FS_NOT_TEXT" || (error as Error).message.includes("FS_NOT_TEXT"));
}


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
				...(cwd === undefined ? {} : { cwd }),
				...(signal === undefined ? {} : { signal }),
			});
			return fs.processPath(target);
		},
		async readText(absolutePath, signal, encodingHint?: string) {
			try {
				// explicit encoding override (Reopen with Encoding)
				if (encodingHint) {
					const norm = normalizeEncoding(encodingHint);
					if (!norm) throw new (await import("@deepseek-ai/dsh-fs")).FsError("bad encoding", "FS_BAD_ENCODING" as any);
					const target = await fs.resolve(absolutePath, { ...(signal === undefined ? {} : { signal }) });
					const info = await fs.stat(target, signal);
					const maxBytes = info?.size ?? 10 * 1024 * 1024;
					const bytes = await fs.readBytes(target, signal, maxBytes);
					const bom = detectBom(bytes);
					const slice = bom ? bytes.subarray(bom.bomLen) : bytes;
					// for utf16 etc, decode via helper
					let decoded = decodeBytes(bom ? bytes : slice, bom ? bom.encoding : norm);
					if (bom && (bom.encoding === "utf8bom" || bom.encoding === "utf16le" || bom.encoding === "utf16be")) {
						decoded = decodeBytes(bytes, bom.encoding);
					} else if (norm) {
						const off = bom ? bom.bomLen : 0;
						decoded = decodeBytes(bytes.subarray(off), norm);
					}
					if (decoded === undefined) throw new (await import("@deepseek-ai/dsh-fs")).FsError("decode failed", "FS_DECODE_FAILED" as any);
					const version = info?.version as string | undefined;
					setEncodingState(String((target as any).targetKey ?? absolutePath), { encoding: norm, hasBOM: !!bom, version });
					return decoded;
				}
				const target = await fs.resolve(absolutePath, {
					...(signal === undefined ? {} : { signal }),
				});
				const text = await fs.readText(target, signal);
				return await restoreStrippedUtf8Bom(fs, target, text, signal);
			} catch (error) {
				// fallback for non-UTF8 when autoGuess enabled; when disabled surface top-3 + hint
				const isNotText = error instanceof Error && (error as any).code === "FS_NOT_TEXT";
				if (isNotText) {
					try {
						const cfg = loadConfig();
						if (cfg.autoGuessEncoding) {
							const target = await fs.resolve(absolutePath, { ...(signal === undefined ? {} : { signal }) });
							const info = await fs.stat(target, signal);
							const maxBytes = info?.size ?? 10 * 1024 * 1024;
							if (info && info.size !== undefined && info.size > maxBytes) throw error;
							const bytes = await fs.readBytes(target, signal, maxBytes);
							const bom = detectBom(bytes);
							if (bom) {
								const dec = decodeBytes(bytes, bom.encoding);
								if (dec !== undefined) {
									setEncodingState(String((target as any).targetKey ?? absolutePath), { encoding: bom.encoding, hasBOM: true, version: info?.version as string | undefined });
									return dec;
								}
							}
							if (isValidUtf8(bytes)) {
								const dec = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
								setEncodingState(String((target as any).targetKey ?? absolutePath), { encoding: "utf8", hasBOM: false, version: info?.version as string | undefined });
								return dec;
							}
							// score allowlist top-3, pick best for now (model will pick via details.candidates in tool layer)
							const allow = cfg.supportedEncodings as string[];
							// try chardet (optional dep) first for more accurate top-1 — with footer for mid-confidence
							try {
								const chardetCands = await chardetTop3Candidates(bytes, allow);
								if (chardetCands.length > 0) {
									const top = chardetCands[0]!;
									const second = chardetCands[1];
									const isMid = top.confidence < 70 || (second !== undefined && top.confidence - second.confidence < 10);
									const dec = decodeBytes(bytes, top.encoding);
									if (dec !== undefined && !dec.includes("\uFFFD")) {
										let footer = "";
										if (isMid) {
											const candsStr = chardetCands.map((c) => `${c.encoding} ${c.confidence}`).join(", ");
											footer = `\n\n[Auto-guessed: ${top.encoding} ${top.confidence}, candidates: ${candsStr} — re-read with read({encoding}) if garbled]`;
										}
										setEncodingState(String((target as any).targetKey ?? absolutePath), { encoding: top.encoding, hasBOM: false, version: info?.version as string | undefined });
										if (footer) setAutoGuessFooter(String((target as any).targetKey ?? absolutePath), footer);
										return dec;
									}
								}
							} catch {}
							const candidates = top3Candidates(bytes, allow);
							if (candidates.length > 0) {
								const best = candidates[0]!;
								const second2 = candidates[1];
								const isMidHeu = second2 !== undefined && best.score - second2.score < 10;
								let footerHeu = "";
								if (true) {
									const candsStrHeu = candidates.map((c) => `${c.encoding} ${c.score.toFixed(0)}`).join(", ");
									footerHeu = `\n\n[Auto-guessed: ${best.encoding} ${best.score.toFixed(0)}, candidates: ${candsStrHeu} — re-read with read({encoding}) if garbled]`;
								}
								const decHeu = decodeBytes(bytes, best.encoding);
								if (decHeu !== undefined) {
									setEncodingState(String((target as any).targetKey ?? absolutePath), { encoding: best.encoding, hasBOM: false, version: info?.version as string | undefined });
									if (footerHeu) setAutoGuessFooter(String((target as any).targetKey ?? absolutePath), footerHeu);
										return decHeu;
								}
							}
						}
						// autoGuess disabled or no candidate succeeded — surface top-3 + env hint
						try {
							const target2 = await fs.resolve(absolutePath, { ...(signal === undefined ? {} : { signal }) });
							const info2 = await fs.stat(target2, signal);
							const maxBytes2 = info2?.size ?? 10 * 1024 * 1024;
							const bytes2 = await fs.readBytes(target2, signal, maxBytes2);
							const allow2 = cfg.supportedEncodings as string[];
							const candsViaChardet = await chardetTop3Candidates(bytes2, allow2);
							const cands = candsViaChardet.length > 0 ? candsViaChardet.map((c) => ({ encoding: c.encoding, sample: c.sample, score: c.confidence })) : top3Candidates(bytes2, allow2);
							if (cands.length > 0) {
								const candStr = cands.map((c) => `${c.encoding}("${c.sample.slice(0, 20).replace(/"/g, "'")}")`).join(", ");
								throw new Error(`[E_NOT_TEXT] Path is not a readable UTF-8 text file: ${absolutePath}. Hashline editing only supports text files. Top-3 guesses: ${candStr}. Try read({encoding: "<encoding>"}) or set DSH_BETTER_EDIT_AUTO_GUESS_ENCODING=true to auto-decode.`);
							}
						} catch (inner) {
							if (inner instanceof Error && inner.message.includes("[E_NOT_TEXT]")) throw inner;
						}
					} catch (e) {
						if (e instanceof Error && e.message.includes("[E_NOT_TEXT]")) throw e;
					}
				}
				return mapFsError(error, absolutePath);
			}
		},
		async writeText(absolutePath, content, signal, exec, sandboxPolicy, encodingHint?: string) {
			// handle drift invalidation before encode
			try {
				const targetTmp = await fs.resolve(absolutePath, { ...(signal === undefined ? {} : { signal }) });
				const key = String((targetTmp as any).targetKey ?? absolutePath);
				const memo = encodingMemo.get(key);
				if (memo) {
					const info = await fs.stat(targetTmp, signal);
					const curVer = info?.version as string | undefined;
					if (curVer !== memo.version) encodingMemo.delete(key);
				}
			} catch {}

			try {
				const target = await fs.resolve(absolutePath, {
					...(signal === undefined ? {} : { signal }),
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
				// re-encode if needed (round-trip unless normalizeToUtf8)
				const writeContent = content;
				try {
					const cfgW = loadConfig();
					if (encodingHint) {
						const normW = normalizeEncoding(encodingHint);
						if (!normW) throw new (await import("@deepseek-ai/dsh-fs")).FsError("bad encoding", "FS_BAD_ENCODING" as any);
						// Save with Encoding: update memo and write as requested encoding (but fs.writeText expects utf8 string, so we keep utf8 string and update memo for next read?)
						// For now, record memo; actual bytes will be written as utf8 string (provider normalizes). For legacy preserve, we would need writeBytes seam — deferred, record state only.
						const tgt = await fs.resolve(absolutePath, { ...(signal === undefined ? {} : { signal }) });
						const inf = await fs.stat(tgt, signal);
						setEncodingState(String((tgt as any).targetKey ?? absolutePath), { encoding: normW, hasBOM: normW === "utf8bom", version: undefined });
					} else if (!cfgW.normalizeToUtf8) {
						const tgt2 = await fs.resolve(absolutePath, { ...(signal === undefined ? {} : { signal }) });
						const mem = encodingMemo.get(String((tgt2 as any).targetKey ?? absolutePath));
						if (mem && mem.encoding !== "utf8" && mem.encoding !== "utf8bom") {
							// For provider that expects utf8 string, we keep string as-is (round-trip would need raw bytes seam). Record indicates file was legacy.
							// No transcode on wire — provider will write utf8; next read will see new version and re-detect.
						}
					}
				} catch {}
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
					...(signal === undefined ? {} : { signal }),
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
					...(signal === undefined ? {} : { signal }),
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
		async readText(absolutePath, signal, encodingHint?: string) {
			signal?.throwIfAborted();
			if (encodingHint) {
				const norm = normalizeEncoding(encodingHint);
				if (!norm) throw new Error(`[E_BAD_ENCODING] Unknown encoding: ${encodingHint}`);
				const bytes = await readFile(absolutePath);
				const bom = detectBom(bytes);
				const off = bom ? bom.bomLen : 0;
				const dec = decodeBytes(bytes.subarray(off), norm ?? "utf8");
				if (dec === undefined) throw new Error(`[E_DECODE_FAILED] Cannot decode ${absolutePath} as ${norm}`);
				const info = await fileSnap(absolutePath).catch(() => undefined);
				setEncodingState(absolutePath, { encoding: norm!, hasBOM: !!bom, version: info?.snapshotId });
				return dec;
			}
			// try deterministic BOM→UTF8 first, then autoGuess if enabled
			try {
				const bytes = await readFile(absolutePath);
				const bom = detectBom(bytes);
				if (bom) {
					const dec = decodeBytes(bytes, bom.encoding);
					if (dec !== undefined) {
						const info = await fileSnap(absolutePath).catch(() => undefined);
						setEncodingState(absolutePath, { encoding: bom.encoding, hasBOM: true, version: info?.snapshotId });
						return dec;
					}
				}
				if (isValidUtf8(bytes)) return bytes.toString("utf-8");
				const cfgL = loadConfig();
				if (cfgL.autoGuessEncoding) {
					// chardet first with footer
					try {
						const chardetCandsL = await chardetTop3Candidates(bytes, cfgL.supportedEncodings as string[]);
						if (chardetCandsL.length > 0) {
							const topL = chardetCandsL[0]!;
							const secondL = chardetCandsL[1];
							const isMidL = topL.confidence < 70 || (secondL !== undefined && topL.confidence - secondL.confidence < 10);
							const decL2 = decodeBytes(bytes, topL.encoding);
							if (decL2 !== undefined && !decL2.includes("\uFFFD")) {
								let footerL = "";
								if (isMidL) {
									const candsStrL = chardetCandsL.map((c) => `${c.encoding} ${c.confidence}`).join(", ");
									footerL = `\n\n[Auto-guessed: ${topL.encoding} ${topL.confidence}, candidates: ${candsStrL} — re-read with read({encoding}) if garbled]`;
								}
								const infoL2 = await fileSnap(absolutePath).catch(() => undefined);
								setEncodingState(absolutePath, { encoding: topL.encoding, hasBOM: false, version: infoL2?.snapshotId });
								if (footerL) setAutoGuessFooter(absolutePath, footerL);
								return decL2;
							}
						}
					} catch {}
					const candidates = top3Candidates(bytes, cfgL.supportedEncodings as string[]);
					if (candidates.length > 0) {
						const best = candidates[0]!;
						const candsStrHeuL = candidates.map((c) => `${c.encoding} ${c.score.toFixed(0)}`).join(", ");
						const footerHeuL = `\n\n[Auto-guessed: ${best.encoding} ${best.score.toFixed(0)}, candidates: ${candsStrHeuL} — re-read with read({encoding}) if garbled]`;
						const dec = decodeBytes(bytes, best.encoding);
						if (dec !== undefined) {
							const info = await fileSnap(absolutePath).catch(() => undefined);
							setEncodingState(absolutePath, { encoding: best.encoding, hasBOM: false, version: info?.snapshotId });
							if (footerHeuL) setAutoGuessFooter(absolutePath, footerHeuL);
							return dec;
						}
					}
				}
			} catch {}
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
