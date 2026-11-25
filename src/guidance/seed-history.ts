/**
 * Historical seed ledger: the identity of every guidance body this plugin has
 * ever shipped, so a user override carrying an old compiled default is still
 * recognised as "refresh" rather than mistaken for deliberate customization.
 *
 * Provenance: each body was rendered from that tag's own `src/prompts.ts` plus
 * `src/guidance/resolve.ts` (its `order` default), read via `git show`, then
 * projected with the v1 projection and hashed with `seedHash` from
 * `./seed.js`. Seeding was preset-independent at every tag — the rendered body
 * does not depend on the preset id — so bodies are keyed by `<tag>/<file>`
 * with no preset level, and every preset maps to the same per-file array.
 *
 * 26 release tags (`v0.3.1` … `v1.2.7`) x 3 section files produce exactly 16
 * distinct `(file, hash)` entries. First tag is the fixture tag under
 * `test/fixtures/guidance-seeds/<tag>/<file>`.
 *
 * `read.md` — 4 versions
 *
 * | First tag | Hash (sha256 hex)                                                  | Tag range covered       |
 * | --------- | ------------------------------------------------------------------ | ----------------------- |
 * | `v0.3.1`  | `2365d8f5cc324776bb5ce1f1e07d071e6048472f4692ed9ae34282725c6f300d` | `v0.3.1` … `v0.8.2`     |
 * | `v1.0.0`  | `db5610063ac32cabe64cd50db50e98df6198b25e9e0a95924edb99a57ca7d9a3` | `v1.0.0`                |
 * | `v1.1.0`  | `26af6f4e56e2bdecdbe840355753fd11d11e87288d1aa492b69e25bcc758066c` | `v1.1.0` … `v1.2.6`     |
 * | `v1.2.7`  | `6ef12232f2c060412eff4c0702d842efc8b79c610158dacc51eafc5cfac905bb` | `v1.2.7`                |
 *
 * `edit.md` — 8 versions
 *
 * | First tag | Hash (sha256 hex)                                                  | Tag range covered   |
 * | --------- | ------------------------------------------------------------------ | ------------------- |
 * | `v0.3.1`  | `4f452892e9cc90740ed436c313648b6b733957af781fde2169edd57ddac9e3db` | `v0.3.1` … `v0.4.1` |
 * | `v0.5.0`  | `5b9e9e0163242730b5b731b236da63ac5f9b7d2b3092df2bc25a47c44e5fd51b` | `v0.5.0` … `v0.6.3` |
 * | `v0.7.0`  | `5304264b819a027ad953e2d6ebd0f90c6f7a4be2ce20357198e31d1b3f0dca40` | `v0.7.0` … `v0.7.1` |
 * | `v0.8.0`  | `080040c2e9d653506ce57eb945b8e4d3e9227aa5c45587531976edf547c37691` | `v0.8.0` … `v0.8.2` |
 * | `v1.0.0`  | `bef02978358bdcbe2039686b008596f13cbaedf15345c27dc5a010400eddc126` | `v1.0.0`            |
 * | `v1.1.0`  | `c451f4590d63a7227a386af5afb5264ce7793a4d5684165d281c741626fc9b0d` | `v1.1.0` … `v1.2.3` |
 * | `v1.2.4`  | `b2b4a0eb5ec31f7bb9274d6016c859e01bdaa3bb02aa3fe4938fb345bbd224c6` | `v1.2.4` … `v1.2.6` |
 * | `v1.2.7`  | `7b56ffe92a5852438ab40e59c8ddcd9047d0e6b92a0f69568fdcf4acfa0135d1` | `v1.2.7`            |
 *
 * `undo_last_edit.md` — 4 versions
 *
 * | First tag | Hash (sha256 hex)                                                  | Tag range covered   |
 * | --------- | ------------------------------------------------------------------ | ------------------- |
 * | `v0.3.1`  | `9b78d9fafd525b52dc1760e8e43c4bc3c48c3843a6300601d9ffa4081f0f20dd` | `v0.3.1` … `v0.8.2` |
 * | `v1.0.0`  | `b89f7f9ac230f167837d4be9904e74d5b2811c33ed64d02e0faf9c589b149416` | `v1.0.0`            |
 * | `v1.1.0`  | `7ccc18acd258dc659bd84c6cbe6b201ac0959b7bd530da847b357ab42682d3c4` | `v1.1.0` … `v1.2.3` |
 * | `v1.2.4`  | `771a24976b077495e5971e6bb454aeba231debc8eba2ae7c32e9211c08736cee` | `v1.2.4` … `v1.2.7` |
 *
 * A release that changes the rendered guidance must append the new hash here
 * and add the matching fixture under
 * `test/fixtures/guidance-seeds/<tag>/<file>`; see `CONTRIBUTING.md` §Release.
 *
 * @module dsh-better-edit/guidance/seed-history
 */
import type { GuidanceFile } from "./seed.js";

const READ_HISTORY: readonly string[] = [
  "2365d8f5cc324776bb5ce1f1e07d071e6048472f4692ed9ae34282725c6f300d",
  "db5610063ac32cabe64cd50db50e98df6198b25e9e0a95924edb99a57ca7d9a3",
  "26af6f4e56e2bdecdbe840355753fd11d11e87288d1aa492b69e25bcc758066c",
  "6ef12232f2c060412eff4c0702d842efc8b79c610158dacc51eafc5cfac905bb",
];

const EDIT_HISTORY: readonly string[] = [
  "4f452892e9cc90740ed436c313648b6b733957af781fde2169edd57ddac9e3db",
  "5b9e9e0163242730b5b731b236da63ac5f9b7d2b3092df2bc25a47c44e5fd51b",
  "5304264b819a027ad953e2d6ebd0f90c6f7a4be2ce20357198e31d1b3f0dca40",
  "080040c2e9d653506ce57eb945b8e4d3e9227aa5c45587531976edf547c37691",
  "bef02978358bdcbe2039686b008596f13cbaedf15345c27dc5a010400eddc126",
  "c451f4590d63a7227a386af5afb5264ce7793a4d5684165d281c741626fc9b0d",
  "b2b4a0eb5ec31f7bb9274d6016c859e01bdaa3bb02aa3fe4938fb345bbd224c6",
  "7b56ffe92a5852438ab40e59c8ddcd9047d0e6b92a0f69568fdcf4acfa0135d1",
];

const UNDO_HISTORY: readonly string[] = [
  "9b78d9fafd525b52dc1760e8e43c4bc3c48c3843a6300601d9ffa4081f0f20dd",
  "b89f7f9ac230f167837d4be9904e74d5b2811c33ed64d02e0faf9c589b149416",
  "7ccc18acd258dc659bd84c6cbe6b201ac0959b7bd530da847b357ab42682d3c4",
  "771a24976b077495e5971e6bb454aeba231debc8eba2ae7c32e9211c08736cee",
];

/** Presets the plugin seeds; mirrors `DEFAULT_PRESETS` in `./materialize.js`. */
type SeededPreset = "standard" | "ptc" | "minimal" | "cordis";

/** Section files a seeded guidance directory carries. */
type SeededFileName = "read.md" | "edit.md" | "undo_last_edit.md";

/** The 12 seeded override-file keys, as a closed union. */
type SeededKey = `${SeededPreset}/${SeededFileName}`;

/**
 * Every hash this plugin has ever seeded, per override file. Presets share the
 * same per-file array because seeding never depended on the preset id.
 *
 * The `satisfies` clause proves the literal carries all 12 seeded keys; the
 * annotation keeps the lookup surface keyed by {@link GuidanceFile}.
 */
export const KNOWN_HISTORICAL_SEEDS: Readonly<Record<GuidanceFile, readonly string[]>> = {
  "standard/read.md": READ_HISTORY,
  "standard/edit.md": EDIT_HISTORY,
  "standard/undo_last_edit.md": UNDO_HISTORY,
  "ptc/read.md": READ_HISTORY,
  "ptc/edit.md": EDIT_HISTORY,
  "ptc/undo_last_edit.md": UNDO_HISTORY,
  "minimal/read.md": READ_HISTORY,
  "minimal/edit.md": EDIT_HISTORY,
  "minimal/undo_last_edit.md": UNDO_HISTORY,
  "cordis/read.md": READ_HISTORY,
  "cordis/edit.md": EDIT_HISTORY,
  "cordis/undo_last_edit.md": UNDO_HISTORY,
} satisfies Record<SeededKey, readonly string[]>;
