# 01 — Deepen file encoding state seam

**What to build:** One module owns the `file encoding state` round-trip (`{encoding, hasBOM, lineEnding}` per CONTEXT.md) so a non-UTF-8 file is handled end-to-end through a single seam — deterministic `BOM → strict UTF-8 → autoGuessEncoding + Top-3 always pushed` admission, canonical encoding enum, and `encodeForSave` inversion on write, with `read({encoding})`/`write({encoding})` manual overrides routing through the same interface. `fs-bridge` becomes a thin IO adapter and `file-view` consumes decoded text.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] Deterministic admission `BOM → strict UTF-8 fatal:true → autoGuess (gate) → Top-3` always surfaced (E_NOT_TEXT details when gated off, auto-guess footer when on) — no silent re-derive
- [ ] Round-trip fidelity: `file encoding state` recorded at open and inverted on save (BOM + lineEnding restored, legacy encodings transcoded back unless `normalizeToUtf8` migrates), invalidated by `FsVersion`
- [ ] Existing encoding tests pass and new pure table tests cover `(bytes, config) → (text, state, Top-3)` without filesystem; `pnpm test` and `npm run typecheck` green
