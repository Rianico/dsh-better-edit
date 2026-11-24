/**
 * Effective EOL — the one terminator a write uses, and the rung that supplied it.
 * `AUTO` (env, config, or default) takes the file's dominant terminator and falls back to the
 * system one; a forced `LF`/`CRLF`/`CR` names its own rung. The read side never throws.
 * Sources are `env | config | file | system`: downstream keeps one YAML config, so the two
 * upstream file rungs (project, global) collapse into `config`.
 * @module dsh-better-edit/eol-config
 */
import type { LineEnding, LineEndingCounts } from "./edit-diff.js";
import { EOL_ENV_VAR, loadConfig, parseEnvEolSetting } from "./store-config.js";
import type { EolSetting } from "./store-config.js";

/** Environment override; wins over the config file. Values outside the enum are ignored. */
export { EOL_ENV_VAR };

/** Every rung that can decide a terminator: the forced two, plus the file and the OS. */
export type EolSource = "env" | "config" | "file" | "system";

/** One resolved terminator: the bytes a write uses, and what decided them. */
export interface ResolvedEffectiveEol {
  readonly value: LineEnding;
  readonly source: EolSource;
}

/** The terminator each forced setting names; `AUTO` is absent and leaves the choice to the file. */
const FORCED_ENDINGS: Readonly<Record<Exclude<EolSetting, "AUTO">, LineEnding>> = {
  LF: "\n",
  CRLF: "\r\n",
  CR: "\r",
};

/** The most frequent terminator kind; ties prefer LF, then CRLF, then CR. `undefined` = none. */
function dominantFromCounts(counts: LineEndingCounts): LineEnding | undefined {
  const best = Math.max(counts.crlf, counts.lf, counts.cr);
  if (best === 0) return undefined;
  if (counts.lf === best) return "\n";
  if (counts.crlf === best) return "\r\n";
  return "\r";
}

/** The terminator a file with no terminator of its own gets on this platform. */
function systemEnding(): LineEnding {
  return process.platform === "win32" ? "\r\n" : "\n";
}

/**
 * The config file's setting, read through the cached loader. `loadConfig()` is total — its fs read,
 * its `safeParse` and its complement write are all wrapped — and other consumers already call it
 * directly, so the resolver inherits the never-throw contract without a branch of its own.
 */
function configSetting(): EolSetting {
  return loadConfig().eol;
}

/**
 * The resolved setting and its rung: a valid env value wins (and `AUTO` there stops the ladder,
 * so the config file cannot override it); otherwise the config file's value decides, whose own
 * invalid spelling already warned inside `loadConfig()`.
 */
function resolvedSetting(): { readonly setting: EolSetting; readonly source: "env" | "config" } {
  const fromEnv = parseEnvEolSetting(process.env[EOL_ENV_VAR]);
  if (fromEnv !== undefined) return { setting: fromEnv, source: "env" };
  return { setting: configSetting(), source: "config" };
}

/** Terminator counts by kind, in one pass: a CRLF pair counts once, never as CR plus LF. */
export function countLineEndings(text: string): LineEndingCounts {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x0a) {
      lf += 1;
    } else if (code === 0x0d) {
      if (text.charCodeAt(index + 1) === 0x0a) {
        crlf += 1;
        index += 1;
      } else {
        cr += 1;
      }
    }
  }
  return { crlf, lf, cr };
}

/** The most frequent terminator kind of `content`: a CRLF pair counts once; ties prefer LF. */
export function dominantEnding(content: string): LineEnding | undefined {
  return dominantFromCounts(countLineEndings(content));
}

/** The name a warning spells for one terminator, matching the `eol` setting's spelling. */
export function endingName(value: LineEnding): "LF" | "CRLF" | "CR" {
  if (value === "\r\n") return "CRLF";
  if (value === "\r") return "CR";
  return "LF";
}

/**
 * How many pre-image terminators a write to `target` REWRITES: every terminator minus the ones
 * already spelled `target`, so a kept terminator counts zero.
 */
export function changedTerminatorCount(counts: LineEndingCounts, target: LineEnding): number {
  const kept = target === "\r\n" ? counts.crlf : target === "\r" ? counts.cr : counts.lf;
  return counts.crlf + counts.lf + counts.cr - kept;
}

/** How many distinct terminator kinds the bytes spell: 0 when none, 1 uniform, 2 or 3 mixed. */
export function terminatorKindsUsed(counts: LineEndingCounts): number {
  return (counts.crlf > 0 ? 1 : 0) + (counts.lf > 0 ? 1 : 0) + (counts.cr > 0 ? 1 : 0);
}

/**
 * The EOL one write uses, with what decided it: a forced setting names its own rung, `AUTO` names
 * `"file"` for the dominant terminator, and `"system"` when the file has none.
 * Takes pre-image counts, so one decode feeds both the choice and the write.
 */
export function resolveEffectiveEolFromCounts(counts: LineEndingCounts): ResolvedEffectiveEol {
  const { setting, source } = resolvedSetting();
  if (setting !== "AUTO") return { value: FORCED_ENDINGS[setting], source };
  const dominant = dominantFromCounts(counts);
  if (dominant !== undefined) return { value: dominant, source: "file" };
  return { value: systemEnding(), source: "system" };
}

/** The content form of the counts resolver: one scan, then the same decision. */
export function resolveEffectiveEol(content: string): ResolvedEffectiveEol {
  return resolveEffectiveEolFromCounts(countLineEndings(content));
}
