/**
 * IO seam for the hashline tool layer. The tools resolve, read, and write
 * through this bridge so they honor the deployment's `ctx.fs` backend — a
 * sandboxed or remote filesystem — instead of reaching around it.
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
import type { LineEnding } from "./edit-diff.js";
import { resolveEncodingMigrationConsent } from "./encoding-consent.js";
import type { EncodingMigrationConsent } from "./encoding-consent.js";
export type { FileEncodingState } from "./file-encoding-state.js";
export {
  _getEncodingState as getEncodingState,
  _setEncodingState as setEncodingState,
  _clearEncodingState as clearEncodingState,
  _getAutoGuessFooter as getAutoGuessFooter,
  _setAutoGuessFooter as setAutoGuessFooter,
  _clearAutoGuessFooter as clearAutoGuessFooter,
};

export function getAutoGuessFooterCompat(k: string): string | undefined {
  return _getAutoGuessFooter(k);
}

/**
 * Per-call create-or-fail demand for the `create` path of `str_replace_editor`
 * only. Every other mutator (`edit`, `insert`, `str_replace`,
 * `undo_last_edit`) keeps today's unconditional intent, so this guard must
 * never be defaulted on: it turns the provider write into
 * `{ kind: "createIfAbsent" }` and the local write into an exclusive open.
 */
export interface WriteGuard {
  readonly createIfAbsent: true;
}

/** The terminator this write must use, decided by the caller's pre-image resolution (#169). */
export interface WriteTextOptions {
  readonly lineEnding?: LineEnding;
  /**
   * The migration consent this write already resolved (#209). Omitted callers let the seam resolve
   * it from the config (`allowEncodingMigration` > legacy `normalizeToUtf8` > `"refuse"`), so the
   * fleet policy applies to `write` / `str_replace_editor` too.
   */
  readonly migrationConsent?: EncodingMigrationConsent;
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
    guard?: WriteGuard,
    options?: WriteTextOptions,
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
        recordOpenState(
          absolutePath,
          decoded.text,
          decoded.encoding,
          decoded.hasBOM,
          info?.version as string | undefined,
        );
        if (decoded.footer) recordFooter(absolutePath, decoded.footer);
        return decoded.text;
      }

      try {
        const target = await fs.resolve(absolutePath, {
          ...(signal === undefined ? {} : { signal }),
        });
        const text = await fs.readText(target, signal);
        const { text: restored, version } = await restoreStrippedUtf8Bom(fs, target, text, signal);
        try {
          const hasBOM = restored.startsWith(UTF8_BOM);
          const clean = hasBOM ? restored.slice(1) : restored;
          recordOpenState(absolutePath, clean, hasBOM ? "utf8bom" : "utf8", hasBOM, version);
          _clearAutoGuessFooter(absolutePath);
        } catch {
          // HACK: best-effort
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
          const decoded = await decodeForOpen(bytes, cfg, { displayPath: absolutePath });
          recordOpenState(
            absolutePath,
            decoded.text,
            decoded.encoding,
            decoded.hasBOM,
            info?.version as string | undefined,
          );
          if (decoded.footer) recordFooter(absolutePath, decoded.footer);
          return decoded.text;
        }
        return mapFsError(error, absolutePath);
      }
    },
    async writeText(absolutePath, content, signal, exec, sandboxPolicy, guard, options) {
      try {
        const target = await fs.resolve(absolutePath, {
          ...(signal === undefined ? {} : { signal }),
        });
        const info = await fs.stat(target, signal).catch(() => undefined);
        const version = info?.version as string | undefined;
        invalidateIfStale(absolutePath, version);

        const cfgW = loadConfig();
        const existing = _getEncodingState(absolutePath);
        const consent =
          options?.migrationConsent ?? resolveEncodingMigrationConsent(undefined, cfgW);
        const prep = prepareForSave(content, existing, {
          migrationConsent: consent,
          displayPath: absolutePath,
          lineEnding: options?.lineEnding,
        });

        const intent = await ctx.waterfall("fs/write-intent", target, exec, () =>
          guard?.createIfAbsent === true ? { kind: "createIfAbsent" as const } : undefined,
        );
        const effectiveIntent =
          guard?.createIfAbsent === true ? ({ kind: "createIfAbsent" } as const) : intent;
        const outcome = await fs.writeText(
          target,
          prep.textToWrite,
          effectiveIntent,
          signal,
          sandboxPolicy,
        );
        ctx.emit("fs/observed", target, { kind: "present", version: outcome.version }, exec);
        if (prep.newState) {
          const written: FileEncodingState = {
            ...prep.newState,
            version: outcome.version as string | undefined,
          };
          _setEncodingState(absolutePath, written);
        }
      } catch (error) {
        if (guard?.createIfAbsent === true && errCode(error) === "FS_NOT_OBSERVED") {
          throw new DomainError("E_FILE_EXISTS", { path: absolutePath });
        }
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
        if (codeOf(error) === "E_UNSUPPORTED_FILE") {
          return readFile(absolutePath, "utf-8");
        }
        throw error;
      }
    },
    async writeText(absolutePath, content, signal, _exec, _sandboxPolicy, guard, options) {
      signal?.throwIfAborted();
      const info = await fileSnap(absolutePath).catch(() => undefined);
      invalidateIfStale(absolutePath, info?.snapshotId);
      const cfgL = loadConfig();
      const consent = options?.migrationConsent ?? resolveEncodingMigrationConsent(undefined, cfgL);
      const prep = prepareForSave(content, _getEncodingState(absolutePath), {
        migrationConsent: consent,
        displayPath: absolutePath,
        lineEnding: options?.lineEnding,
      });
      await writeAtomic(
        absolutePath,
        prep.textToWrite,
        guard?.createIfAbsent === true ? { exclusive: true } : undefined,
      );
      if (prep.newState) {
        const after = await fileSnap(absolutePath).catch(() => undefined);
        _setEncodingState(absolutePath, { ...prep.newState, version: after?.snapshotId });
      }
    },
    async emitObserved() {},
    async statVersion(absolutePath) {
      try {
        return (await fileSnap(absolutePath)).snapshotId;
      } catch {
        return undefined;
      }
    },
  };
}
