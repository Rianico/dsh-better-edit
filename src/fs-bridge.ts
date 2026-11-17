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
import { fileSnap } from "./file-view.js";
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
import { codeOf, errCode } from "./utils.js";
import { SUPPORTED_ENCODINGS_LABEL } from "./encoding.js";
import { DomainError } from "./domain-errors.js";
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
  emitObserved(absolutePath: string, exec?: ToolExecution, signal?: AbortSignal): Promise<void>;
  /** Opaque change-version for snapshot bookkeeping, or undefined when unavailable. */
  statVersion(absolutePath: string, signal?: AbortSignal): Promise<string | undefined>;
}

/**
 * Map an `ctx.fs` failure onto the hashline model-facing vocabulary so the
 * model sees the same structured error codes as the pure pipeline.
 * @param error - the thrown FsError or any error.
 * @param displayPath - the path as the model wrote it.
 * @returns the mapped error, rethrown.
 */
export function mapFsError(error: unknown, displayPath: string): never {
  if (error instanceof Error && typeof (error as { code?: unknown }).code === "string") {
    // SAFETY: provider failures (FsError or the local backend's plain Error) carry a
    // string `code` field that the published error type does not declare.
    const code = (error as unknown as { code: string }).code;
    if (code === "FS_NOT_FOUND") {
      throw new DomainError("E_NOT_FOUND", { path: displayPath });
    }
    if (code === "FS_PERMISSION_DENIED") {
      throw new DomainError("E_ACCESS", { path: displayPath, kind: "denied" });
    }
    if (code === "FS_NOT_TEXT" || code === "FS_NOT_REGULAR_FILE") {
      throw new DomainError("E_UNSUPPORTED_FILE", {
        path: displayPath,
        kind: "binary",
        description:
          'not a readable UTF-8 text file (try read({encoding: "gbk"}) or enable autoGuessEncoding)',
      });
    }
    if (code === "FS_BAD_ENCODING") {
      throw new DomainError("E_BAD_PAYLOAD", {
        message: `Unknown encoding for ${displayPath}. Supported: ${SUPPORTED_ENCODINGS_LABEL}`,
      });
    }
    if (code === "FS_DECODE_FAILED") {
      throw new DomainError("E_UNSUPPORTED_FILE", {
        path: displayPath,
        kind: "binary",
        description: "bytes cannot be decoded with requested encoding",
      });
    }
    if (code === "FS_STALE_VERSION") {
      throw new DomainError("E_STALE_RANGE", {
        headline:
          "The file changed on disk since it was read (version guard rejected the write). Call read() to get fresh anchors, then retry.",
        servedRows: [],
        servedBlock: "",
        // F7: row-less and read-required — no `Current range:` section, no retry hint.
      });
    }
    if (code === "FS_NOT_OBSERVED") {
      throw new DomainError("E_BLIND_REPLACE", { path: displayPath, command: "write" });
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
): Promise<{ text: string; version: string | undefined }> {
  // BOM already preserved: one metadata stat for the read-first gate version
  // (issue #69). No byte probe here — readBytes stays forbidden in this branch.
  if (text.startsWith(UTF8_BOM)) {
    const info = await fs.stat(target, signal).catch(() => undefined);
    return { text, version: info?.version as string | undefined };
  }

  const info = await fs.stat(target, signal);
  const version = info?.version as string | undefined;
  if (info?.size === undefined || info.size !== Buffer.byteLength(text, "utf-8") + UTF8_BOM_LEN) {
    return { text, version };
  }

  const bytes = await fs.readBytes(target, signal, info.size);
  const encodedText = Buffer.from(text, "utf-8");
  if (
    bytes.length !== encodedText.length + UTF8_BOM_LEN ||
    bytes[0] !== UTF8_BOM_BYTES[0] ||
    bytes[1] !== UTF8_BOM_BYTES[1] ||
    bytes[2] !== UTF8_BOM_BYTES[2]
  ) {
    return { text, version };
  }
  for (let i = 0; i < encodedText.length; i += 1) {
    if (bytes[i + UTF8_BOM_LEN] !== encodedText[i]) return { text, version };
  }
  return { text: `${UTF8_BOM}${text}`, version };
}

/**
 * The memo/policy key for a resolved target: the backend's optional `targetKey`
 * when it carries one (symlink/case canonicalisation), else the absolute path.
 * One seam for the five read/write sites so the memo cannot be keyed two ways.
 */
function targetKeyOf(target: FsTarget, absolutePath: string): string {
  // SAFETY: FsTarget is opaque; `targetKey` is an optional string field on the local backend.
  return String((target as unknown as { targetKey?: string }).targetKey ?? absolutePath);
}
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
        const target = await fs.resolve(absolutePath, {
          ...(signal === undefined ? {} : { signal }),
        });
        const info = await fs.stat(target, signal);
        const maxBytes = info?.size ?? 10 * 1024 * 1024;
        const bytes = await fs.readBytes(target, signal, maxBytes);
        const cfg = loadConfig();
        const decoded = await decodeForOpen(bytes, cfg, {
          encodingHint,
          displayPath: absolutePath,
        });
        const targetKey = targetKeyOf(target, absolutePath);
        recordOpenState(
          targetKey,
          decoded.text,
          decoded.encoding,
          decoded.hasBOM,
          info?.version as string | undefined,
        );
        // Gate looks up by resolved absolutePath; targetKey may differ
        // (symlink/case) — mirror under both keys (issue #69 note).
        if (targetKey !== absolutePath) {
          recordOpenState(
            absolutePath,
            decoded.text,
            decoded.encoding,
            decoded.hasBOM,
            info?.version as string | undefined,
          );
        }
        if (decoded.footer) {
          recordFooter(targetKey, decoded.footer);
          if (targetKey !== absolutePath) recordFooter(absolutePath, decoded.footer);
        }
        return decoded.text;
      }

      try {
        const target = await fs.resolve(absolutePath, {
          ...(signal === undefined ? {} : { signal }),
        });
        const text = await fs.readText(target, signal);
        // Thread the restore path's stat version into the encoding memo so the
        // read-first gate validates against the real version (issue #69 fix 2).
        // The BOM-preserved branch stats for version only — no byte probe.
        const { text: restored, version } = await restoreStrippedUtf8Bom(fs, target, text, signal);
        // record file encoding state for round-trip (BOM + lineEnding)
        try {
          const targetKey = targetKeyOf(target, absolutePath);
          const hasBOM = restored.startsWith(UTF8_BOM);
          const clean = hasBOM ? restored.slice(1) : restored;
          // use seam to record with correct lineEnding detection
          recordOpenState(targetKey, clean, hasBOM ? "utf8bom" : "utf8", hasBOM, version);
          if (targetKey !== absolutePath) {
            recordOpenState(absolutePath, clean, hasBOM ? "utf8bom" : "utf8", hasBOM, version);
          }
          // clear any stale autoGuess footer on clean UTF-8 read
          _clearAutoGuessFooter(targetKey);
          if (targetKey !== absolutePath) _clearAutoGuessFooter(absolutePath);
        } catch {
          // best-effort
        }
        return restored;
      } catch (error) {
        const isNotText = errCode(error) === "FS_NOT_TEXT";
        if (isNotText) {
          const cfg = loadConfig();
          const target = await fs.resolve(absolutePath, {
            ...(signal === undefined ? {} : { signal }),
          });
          const info = await fs.stat(target, signal);
          const maxBytes = info?.size ?? 10 * 1024 * 1024;
          if (info && info.size !== undefined && info.size > maxBytes) throw error;
          const bytes = await fs.readBytes(target, signal, maxBytes);
          const targetKey = targetKeyOf(target, absolutePath);
          // Delegate deterministic admission to the deep seam
          const decoded = await decodeForOpen(bytes, cfg, { displayPath: absolutePath });
          recordOpenState(
            targetKey,
            decoded.text,
            decoded.encoding,
            decoded.hasBOM,
            info?.version as string | undefined,
          );
          if (targetKey !== absolutePath) {
            recordOpenState(
              absolutePath,
              decoded.text,
              decoded.encoding,
              decoded.hasBOM,
              info?.version as string | undefined,
            );
          }
          if (decoded.footer) {
            recordFooter(targetKey, decoded.footer);
            if (targetKey !== absolutePath) recordFooter(absolutePath, decoded.footer);
          }
          return decoded.text;
        }
        return mapFsError(error, absolutePath);
      }
    },
    async writeText(absolutePath, content, signal, exec, sandboxPolicy) {
      try {
        const target = await fs.resolve(absolutePath, {
          ...(signal === undefined ? {} : { signal }),
        });
        const key = targetKeyOf(target, absolutePath);
        // Drop a memo that no longer matches the on-disk version before deciding:
        // the save verdict must describe the bytes actually being replaced.
        const info = await fs.stat(target, signal).catch(() => undefined);
        const version = info?.version as string | undefined;
        invalidateIfStale(key, version);
        if (key !== absolutePath) invalidateIfStale(absolutePath, version);

        // The seam owns the round-trip verdict. It throws E_ENCODING_UNWRITABLE
        // BEFORE the provider sees a write when the recorded encoding cannot be
        // reproduced through the text-only write (issue #112).
        const cfgW = loadConfig();
        const existing = _getEncodingState(key) ?? _getEncodingState(absolutePath);
        const prep = prepareForSave(content, existing, {
          normalizeToUtf8: cfgW.normalizeToUtf8,
          displayPath: absolutePath,
        });

        const intent = await ctx.waterfall("fs/write-intent", target, exec, () => undefined);
        // The provider encodes the string as UTF-8; prep.textToWrite already carries
        // the restored BOM + line endings (or the explicit normalizeToUtf8 migration).
        const outcome = await fs.writeText(target, prep.textToWrite, intent, signal, sandboxPolicy);
        ctx.emit("fs/observed", target, { kind: "present", version: outcome.version }, exec);
        // Memo/bytes agreement: every write records the state of the bytes just written.
        if (prep.newState) {
          const written: FileEncodingState = {
            ...prep.newState,
            version: outcome.version as string | undefined,
          };
          _setEncodingState(key, written);
          if (key !== absolutePath) _setEncodingState(absolutePath, written);
        }
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
          ctx.emit("fs/observed", target, { kind: "present", version: info.version }, exec);
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
        const decoded = await decodeForOpen(bytes, cfg, {
          encodingHint,
          displayPath: absolutePath,
        });
        const info = await fileSnap(absolutePath).catch(() => undefined);
        recordOpenState(
          absolutePath,
          decoded.text,
          decoded.encoding,
          decoded.hasBOM,
          info?.snapshotId,
        );
        if (decoded.footer) recordFooter(absolutePath, decoded.footer);
        return decoded.text;
      }
      // Deterministic path via seam, with local fallback for E_UNSUPPORTED_FILE when autoGuess off
      try {
        const bytes = await readFile(absolutePath);
        const cfgL = loadConfig();
        const decoded = await decodeForOpen(bytes, cfgL, { displayPath: absolutePath });
        const info = await fileSnap(absolutePath).catch(() => undefined);
        recordOpenState(
          absolutePath,
          decoded.text,
          decoded.encoding,
          decoded.hasBOM,
          info?.snapshotId,
        );
        if (decoded.footer) recordFooter(absolutePath, decoded.footer);
        return decoded.text;
      } catch (error) {
        // Local fallback: when autoGuess off, E_UNSUPPORTED_FILE should fall back to raw UTF-8 with � (no throw)
        if (codeOf(error) === "E_UNSUPPORTED_FILE") {
          return readFile(absolutePath, "utf-8");
        }
        throw error;
      }
    },
    async writeText(absolutePath, content, signal, _exec, _sandboxPolicy) {
      signal?.throwIfAborted();
      // Drop a stale memo, then let the seam decide: it throws E_ENCODING_UNWRITABLE
      // before writeAtomic when the recorded encoding cannot round-trip (#112).
      const info = await fileSnap(absolutePath).catch(() => undefined);
      invalidateIfStale(absolutePath, info?.snapshotId);
      const cfgL = loadConfig();
      const prep = prepareForSave(content, _getEncodingState(absolutePath), {
        normalizeToUtf8: cfgL.normalizeToUtf8,
        displayPath: absolutePath,
      });
      await writeAtomic(absolutePath, prep.textToWrite);
      if (prep.newState) {
        const after = await fileSnap(absolutePath).catch(() => undefined);
        _setEncodingState(absolutePath, { ...prep.newState, version: after?.snapshotId });
      }
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
