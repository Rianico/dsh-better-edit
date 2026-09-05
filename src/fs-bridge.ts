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
import { fileSnap } from "./file-reader.js";
import { resolveTarget, toCwd } from "./paths.js";
import {
  decodeForOpen,
  recordOpenState,
  recordFooter,
  getEncodingState as _getEncodingState,
  setEncodingState as _setEncodingState,
  clearEncodingState as _clearEncodingState,
  getAutoGuessFooter as _getAutoGuessFooter,
  setAutoGuessFooter as _setAutoGuessFooter,
  clearAutoGuessFooter as _clearAutoGuessFooter,
  invalidateIfStale,
  prepareForSave,
} from "./file-encoding-state.js";
import type { FileEncodingState } from "./file-encoding-state.js";

// Re-export file encoding state seam for backward compat (file-view, read-and-serve, tests)
export type { FileEncodingState } from "./file-encoding-state.js";
export {
  _getEncodingState as getEncodingState,
  _setEncodingState as setEncodingState,
  _clearEncodingState as clearEncodingState,
  _getAutoGuessFooter as getAutoGuessFooter,
  _setAutoGuessFooter as setAutoGuessFooter,
  _clearAutoGuessFooter as clearAutoGuessFooter,
};

// Keep alias for tests that import getAutoGuessFooter via fs-bridge
export function getAutoGuessFooterCompat(k: string): string | undefined {
  return _getAutoGuessFooter(k);
}

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
    const code = (error as unknown as { code: string }).code;
    if (code === "FS_NOT_FOUND") {
      throw new Error(`[MODEL] [E_NOT_FOUND] File not found: ${displayPath}`);
    }
    if (code === "FS_PERMISSION_DENIED") {
      throw new Error(`[MODEL] [E_ACCESS] Cannot access file: ${displayPath}`);
    }
    if (code === "FS_NOT_TEXT" || code === "FS_NOT_REGULAR_FILE") {
      throw new Error(
        `[MODEL] [E_UNSUPPORTED_FILE] Path is not a readable UTF-8 text file: ${displayPath}. Hashline editing only supports text files. Try read({encoding: "gbk"}) or enable autoGuessEncoding.`,
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
        `[MODEL] [E_STALE_RANGE] The file changed on disk since it was read (version guard rejected the write). Call read() to get fresh anchors, then retry.`,
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
        ...(cwd === undefined ? {} : { cwd }),
        ...(signal === undefined ? {} : { signal }),
      });
      return fs.processPath(target);
    },
    async readText(absolutePath, signal, encodingHint?: string) {
      // explicit encoding override (Reopen with Encoding) — bytes + seam
      if (encodingHint) {
        const target = await fs.resolve(absolutePath, { ...(signal === undefined ? {} : { signal }) });
        const info = await fs.stat(target, signal);
        const maxBytes = info?.size ?? 10 * 1024 * 1024;
        const bytes = await fs.readBytes(target, signal, maxBytes);
        const cfg = loadConfig();
        const decoded = await decodeForOpen(bytes, cfg, { encodingHint, displayPath: absolutePath });
        const targetKey = String((target as unknown as { targetKey?: string }).targetKey ?? absolutePath);
        recordOpenState(targetKey, decoded.text, decoded.encoding, decoded.hasBOM, info?.version as string | undefined);
        if (decoded.footer) recordFooter(targetKey, decoded.footer);
        return decoded.text;
      }

      try {
        const target = await fs.resolve(absolutePath, {
          ...(signal === undefined ? {} : { signal }),
        });
        const text = await fs.readText(target, signal);
        const restored = await restoreStrippedUtf8Bom(fs, target, text, signal);
        // record file encoding state for round-trip (BOM + lineEnding)
        // Do not probe fs.stat when BOM is already preserved — keep the no-probe guarantee
        // tested in fs-bridge.policy.test.ts (keeps a BOM already preserved without probing)
        try {
          const targetKey = String((target as unknown as { targetKey?: string }).targetKey ?? absolutePath);
          const hasBOM = restored.startsWith(UTF8_BOM);
          const clean = hasBOM ? restored.slice(1) : restored;
          // use seam to record with correct lineEnding detection; version left undefined
          // to avoid extra stat (the success path must stay probe-free when BOM preserved)
          recordOpenState(targetKey, clean, hasBOM ? "utf8bom" : "utf8", hasBOM, undefined);
          // clear any stale autoGuess footer on clean UTF-8 read
          _clearAutoGuessFooter(targetKey);
        } catch {
          // best-effort
        }
        return restored;
      } catch (error) {
        const isNotText = error instanceof Error && (error as unknown as { code?: string }).code === "FS_NOT_TEXT";
        if (isNotText) {
          const cfg = loadConfig();
          const target = await fs.resolve(absolutePath, { ...(signal === undefined ? {} : { signal }) });
          const info = await fs.stat(target, signal);
          const maxBytes = info?.size ?? 10 * 1024 * 1024;
          if (info && info.size !== undefined && info.size > maxBytes) throw error;
          const bytes = await fs.readBytes(target, signal, maxBytes);
          const targetKey = String((target as unknown as { targetKey?: string }).targetKey ?? absolutePath);
          // Delegate deterministic admission to the deep seam
          const decoded = await decodeForOpen(bytes, cfg, { displayPath: absolutePath });
          recordOpenState(targetKey, decoded.text, decoded.encoding, decoded.hasBOM, info?.version as string | undefined);
          if (decoded.footer) recordFooter(targetKey, decoded.footer);
          return decoded.text;
        }
        return mapFsError(error, absolutePath);
      }
    },
    async writeText(absolutePath, content, signal, exec, sandboxPolicy) {
      // handle drift invalidation before encode — seam owns version check
      try {
        const targetTmp = await fs.resolve(absolutePath, { ...(signal === undefined ? {} : { signal }) });
        const key = String((targetTmp as unknown as { targetKey?: string }).targetKey ?? absolutePath);
        const info = await fs.stat(targetTmp, signal).catch(() => undefined);
        invalidateIfStale(key, info?.version as string | undefined);
      } catch {} // biome-ignore: best-effort

      try {
        const target = await fs.resolve(absolutePath, {
          ...(signal === undefined ? {} : { signal }),
        });
        const intent = await ctx.waterfall(
          "fs/write-intent",
          target,
          exec,
          () => undefined,
        );
        // Seam owns Save-with-Encoding memo update and normalizeToUtf8 check.
        // Provider expects UTF-8 string; for legacy without normalize we keep
        // string as-is (next read re-detects via version bump).
        try {
          const cfgW = loadConfig();
          const key = String((target as unknown as { targetKey?: string }).targetKey ?? absolutePath);
          // Honor manual override if content was produced via write({encoding}) — not wired here,
          // encodingHint is not part of writeText signature for ctxFsIO in current call sites.
          // Check existing memo for legacy preservation.
          const existing = _getEncodingState(key);
          const prep = prepareForSave(content, existing, { normalizeToUtf8: cfgW.normalizeToUtf8 });
          // For Save with Encoding hint, prepareForSave would create newState — not used in this path (tool-undo/write-hook carry hint separately)
          if (prep.newState) _setEncodingState(key, prep.newState as FileEncodingState);
          // content stays as UTF-8 string for provider; prep.textToWrite is same as content
        } catch {} // biome-ignore: best-effort
        const outcome = await fs.writeText(
          target,
          content,
          intent,
          signal,
          sandboxPolicy,
        );
        ctx.emit(
          "fs/observed",
          target,
          { kind: "present", version: outcome.version },
          exec,
        );
      } catch (error) {
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
        const bytes = await readFile(absolutePath);
        const cfg = loadConfig();
        const decoded = await decodeForOpen(bytes, cfg, { encodingHint, displayPath: absolutePath });
        const info = await fileSnap(absolutePath).catch(() => undefined);
        recordOpenState(absolutePath, decoded.text, decoded.encoding, decoded.hasBOM, info?.snapshotId);
        if (decoded.footer) recordFooter(absolutePath, decoded.footer);
        return decoded.text;
      }
      // Deterministic path via seam, with local fallback for E_UNSUPPORTED_FILE when autoGuess off
      try {
        const bytes = await readFile(absolutePath);
        const cfgL = loadConfig();
        const decoded = await decodeForOpen(bytes, cfgL, { displayPath: absolutePath });
        const info = await fileSnap(absolutePath).catch(() => undefined);
        recordOpenState(absolutePath, decoded.text, decoded.encoding, decoded.hasBOM, info?.snapshotId);
        if (decoded.footer) recordFooter(absolutePath, decoded.footer);
        return decoded.text;
      } catch (error) {
        // Local fallback: when autoGuess off, E_UNSUPPORTED_FILE should fall back to raw UTF-8 with � (no throw)
        if (error instanceof Error && error.message.includes("[E_UNSUPPORTED_FILE]")) {
          return readFile(absolutePath, "utf-8");
        }
        throw error;
      }
    },
    async writeText(absolutePath, content, signal, _exec, _sandboxPolicy) {
      signal?.throwIfAborted();
      // Invalidate stale memo before write, and handle lineEnding via seam if needed
      try {
        const info = await fileSnap(absolutePath).catch(() => undefined);
        invalidateIfStale(absolutePath, info?.snapshotId);
      } catch {}
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
