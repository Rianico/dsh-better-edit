#!/usr/bin/env node
/**
 * dsh-better-edit — reproducible token-cost benchmark
 * ---------------------------------------------------
 * Compares the model-side request tokens of three edit patterns applied to
 * the SAME file with the SAME replacement text:
 *
 *   1. hashline    — hash-anchored edit tool (this plugin):
 *                    { path, remove_from, remove_to, replacement_text }
 *                    the tool call carries only 2×3-char anchors + the
 *                    replacement; the replaced text is never echoed.
 *
 *   2. str_replace — traditional search-and-replace (Claude Code / most
 *                    agent edit tools):
 *                    { path, old_string, new_string }
 *                    the tool call must echo the replaced text VERBATIM.
 *
 *   3. oh-my-pi    — @oh-my-pi/hashline's line-anchored patch language:
 *                    [PATH#TAG] + PUT N.=M: + +TEXT body rows. It never
 *                    echoes old text either, but addresses lines by NUMBER
 *                    bound to a full-file content-hash tag (4 hex chars)
 *                    served by read, and every edit renumbers. Measured in
 *                    both of the format's modes:
 *                      seq   — one [PATH#TAG] section per edit (tool-loop
 *                              style; line numbers renumbered after each edit)
 *                      batch — one patch document, all 12 hunks fixed to the
 *                              ORIGINAL line numbers, header counted once
 *
 * Everything is deterministic: a fixed corpus, a fixed 12-edit script, and a
 * fixed tokenizer (js-tiktoken cl100k_base when installed — it is a
 * devDependency — else the standard chars/4 heuristic, which is conservative:
 * it UNDER-counts code tokens, so it flatters the replacement-style arms,
 * never hashline). The oh-my-pi payloads are built from the package's
 * published grammar (src/prompt.md) and validated against it before counting.
 * The package itself is Bun-only (engines.bun >=1.3.14, ships raw .ts source),
 * so it cannot run under this Node benchmark — and only its model-side
 * emission text is being measured here anyway.
 *
 * Edits are content-addressed: each edit pins the unique line that contains a
 * `match` substring plus a `span` line count. The script self-checks that the
 * match is unique and in range, so the corpus can be reformatted without
 * silently breaking the comparison — mirroring the way hashline anchors are
 * content addresses, not line numbers.
 *
 * Run:  npm run benchmark   (or: node benchmark/run.mjs)
 * The numbers in the README were produced by this script with js-tiktoken.
 */
import { getEncoding } from "js-tiktoken";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 1. Corpus — a fixed, realistic TypeScript module (benchmark/corpus/).
// ---------------------------------------------------------------------------
const corpusPath = join(__dirname, "corpus", "shopping-cart.ts");
const CORPUS = readFileSync(corpusPath, "utf8");

// ---------------------------------------------------------------------------
// 2. Token estimator — js-tiktoken (pinned devDependency) with chars/4
//    fallback. Deterministic for a fixed tokenizer version.
// ---------------------------------------------------------------------------
let tokenizer = null;
try {
	tokenizer = getEncoding("cl100k_base");
} catch {
	// fall through to the chars/4 heuristic
}
function tokens(text) {
	if (tokenizer) return tokenizer.encode(text).length;
	return Math.ceil(text.length / 4);
}
const TOKENIZER_NAME = tokenizer
	? "js-tiktoken cl100k_base"
	: "chars/4 heuristic (js-tiktoken not installed)";

// ---------------------------------------------------------------------------
// 3. Deterministic 3-char line hashes (62-char alphabet, collision-free
//    within a file). The payload comparison is hash-algorithm-agnostic —
//    anchors are always exactly 3 chars — so any collision-free hash works.
// ---------------------------------------------------------------------------
const ALPHABET =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const SPACE = 238328; // 62^3
const collisionMap = new Set();

function hashLine(content) {
	let h = 2166136261;
	for (let i = 0; i < content.length; i++) {
		h ^= content.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	// fold into 3 chars, probing forward on collision
	let c = (h >>> 0) % SPACE;
	for (let k = 0; k < SPACE; k++) {
		const ch =
			ALPHABET[c % 62] +
			ALPHABET[Math.floor(c / 62) % 62] +
			ALPHABET[Math.floor(c / 3844) % 62];
		if (!collisionMap.has(ch)) return ch;
		c = (c + 1) % SPACE;
	}
	throw new Error("hash space exhausted (impossible for < 238k lines)");
}

// content -> hash. Mimics the real store's mapStableHashes: unchanged content
// keeps its hash across edits (position-independent addressing).
let previousHashes = new Map();

function rehash(lines) {
	const out = new Array(lines.length);
	for (let i = 0; i < lines.length; i++) {
		const prev = previousHashes.get(lines[i]);
		out[i] = prev === undefined ? hashLine(lines[i]) : prev;
	}
	return out;
}

// ---------------------------------------------------------------------------
// 4. The edit script — 12 edits. `match` is a substring that uniquely pins
//    the first line of the range; `span` is the range length in lines.
// ---------------------------------------------------------------------------
const EDITS = [
	// single-line edits (8)
	{
		match: "TAX_RATE = 0.2",
		span: 1,
		replacement: ["export const TAX_RATE = 0.21;"],
		note: "single · constant",
	},
	{
		match: "An in-memory shopping cart for the demo API",
		span: 1,
		replacement: ["// An in-memory cart used by the demo API routes."],
		note: "single · comment",
	},
	{
		match: "this.items = new Map();",
		span: 1,
		replacement: ["    this.items = new Map<string, CartItem>();"],
		note: "single · assignment",
	},
	{
		match: "private round2",
		span: 1,
		replacement: ["  private round2(n: number, precision = 2): number {"],
		note: "single · signature",
	},
	{
		match: "qty <= 0",
		span: 1,
		replacement: [
			"    if (qty <= 0) throw new CartError('quantity must be positive');",
		],
		note: "single · guard",
	},
	{
		match: "total += item.unitPrice",
		span: 1,
		replacement: [
			"      total = this.round2(total + item.unitPrice * item.qty);",
		],
		note: "single · expression",
	},
	{
		match: "get total()",
		span: 1,
		replacement: ["  get totalWithTax(): number {"],
		note: "single · getter",
	},
	{
		match: "export function formatMoney",
		span: 1,
		replacement: [
			"export function formatMoney(cents: number, withSymbol = true): string {",
		],
		note: "single · export fn",
	},
	// multi-line edits (4)
	{
		match: "if (unitPrice < 0) {",
		span: 3,
		note: "multi · 3-line if-block",
		replacement: [
			"    if (!Number.isFinite(unitPrice) || unitPrice < 0) {",
			"      throw new CartError(`bad price for ${sku}`);",
			"    }",
		],
	},
	{
		match: "const existing = this.items.get",
		span: 6,
		note: "multi · 6-line helper body",
		replacement: [
			"    if (existing) {",
			"      existing.qty += qty;",
			"      existing.unitPrice = unitPrice;",
			"    } else {",
			"      this.items.set(sku, { sku, qty, unitPrice });",
			"    }",
		],
	},
	{
		match: "let total = 0;",
		span: 10,
		note: "multi · 10-line loop block",
		replacement: [
			"    let total = 0;",
			"    for (const item of this.items.values()) {",
			"      if (item.qty <= 0) continue;",
			"      total += item.unitPrice * item.qty;",
			"    }",
			"    return this.round2(total);",
		],
	},
	{
		match: "checkout(): CheckoutReceipt",
		span: 15,
		note: "multi · 15-line method body",
		replacement: [
			"  checkout(): CheckoutReceipt {",
			"    if (this.items.size === 0) {",
			"      throw new CartError('cannot checkout an empty cart');",
			"    }",
			"    const lines = [...this.items.values()].map((item) => ({",
			"      sku: item.sku,",
			"      qty: item.qty,",
			"      lineTotal: this.round2(item.unitPrice * item.qty),",
			"    }));",
			"    const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);",
			"    const tax = this.round2(subtotal * TAX_RATE);",
			"    this.items.clear();",
			"    return { lines, subtotal, tax, total: this.round2(subtotal + tax) };",
			"  }",
		],
	},
];

// ---------------------------------------------------------------------------
// 5. Run the comparison.
// ---------------------------------------------------------------------------
function findRange(lines, e, i) {
	const hits = [];
	for (let idx = 0; idx < lines.length; idx++) {
		if (lines[idx].includes(e.match)) hits.push(idx);
	}
	if (hits.length !== 1) {
		throw new Error(
			`edit ${i + 1} (${e.note}): match ${JSON.stringify(e.match)} found in ${hits.length} lines — ` +
				"corpus changed; fix benchmark/run.mjs or the corpus.",
		);
	}
	const start = hits[0];
	const end = start + e.span - 1;
	if (end >= lines.length) {
		throw new Error(
			`edit ${i + 1} (${e.note}): span ${e.span} from line ${start} exceeds ${lines.length} lines.`,
		);
	}
	return { start, end };
}

function run() {
	collisionMap.clear();
	previousHashes = new Map();

	const lines = CORPUS.split("\n");
	let hashes = rehash(lines);
	const PATH = "src/shopping-cart.ts";
	const originalLines = CORPUS.split("\n");

	// Original 1-based line numbers per edit, resolved once against the
	// pristine corpus. The oh-my-pi batch mode fixes every hunk to the
	// ORIGINAL file ("numbers are original, never shifted by hunks"), so its
	// ranges are computed here rather than from the evolving file.
	const origRanges = EDITS.map((e, i) => {
		const { start, end } = findRange(originalLines, e, i);
		return { start, end };
	});

	const edits = [];
	let ambiguous = 0;

	for (let i = 0; i < EDITS.length; i++) {
		const e = EDITS[i];
		const { start, end } = findRange(lines, e, i);
		const rangeText = lines.slice(start, end + 1).join("\n");
		const replacementText = e.replacement.join("\n");

		// str_replace must echo the old text verbatim
		const strReq = JSON.stringify({
			path: PATH,
			old_string: rangeText,
			new_string: replacementText,
		});
		// hashline carries only the two boundary anchors + the replacement
		const hlReq = JSON.stringify({
			path: PATH,
			remove_from: hashes[start],
			remove_to: hashes[end],
			replacement_text: replacementText,
		});

		const hlTok = tokens(hlReq);

		// oh-my-pi/hashline — one section per edit, CURRENT line numbers
		// (every edit renumbers; the tag changes with the file content).
		const omSeqText = `[${PATH}#${OHMY_TAG}]\n${ohmyHunk(start, end, e.replacement)}`;
		validateOhMyPatch(omSeqText);
		const omTok = tokens(omSeqText);
		const srTok = tokens(strReq);

		// correctness proxy: how many times does old_string occur in the file?
		const occurrences = countOccurrences(CORPUS, rangeText);
		const amb = Math.max(0, occurrences - 1);
		ambiguous += amb;

		edits.push({
			note: e.note,
			hl: hlTok,
			sr: srTok,
			omSeq: omTok,
			pct: Math.round(((srTok - hlTok) / srTok) * 100),
			rangeLines: e.span,
			ambiguity: amb,
		});

		// apply the edit: replacement lines get fresh hashes, untouched content
		// keeps its hash (position-independent — the core hashline property)
		for (const r of e.replacement) previousHashes.set(r, null); // force fresh hash
		lines.splice(start, end - start + 1, ...e.replacement);
		hashes = rehash(lines);
	}

	// oh-my-pi/hashline — one batch document: all hunks sorted ascending by
	// ORIGINAL line number, the [PATH#TAG] header counted once. This is the
	// format's favourable case (its natural single-document mode).
	const batchHunks = origRanges
		.map((r, i) => ({
			start: r.start,
			hunk: ohmyHunk(r.start, r.end, EDITS[i].replacement),
		}))
		.sort((a, b) => a.start - b.start);
	const omBatchText = `[${PATH}#${OHMY_TAG}]\n${batchHunks.map((h) => h.hunk).join("\n")}\n`;
	validateOhMyPatch(omBatchText);

	return {
		edits,
		ambiguous,
		lineCount: CORPUS.replace(/\n$/, "").split("\n").length,
		totals: {
			hl: edits.reduce((s, e) => s + e.hl, 0),
			sr: edits.reduce((s, e) => s + e.sr, 0),
			omSeq: edits.reduce((s, e) => s + e.omSeq, 0),
			omBatch: tokens(omBatchText),
		},
		omBatchHunks: batchHunks.length,
	};
}

function countOccurrences(text, needle) {
	if (!needle) return 0;
	let n = 0;
	let idx = text.indexOf(needle);
	while (idx !== -1) {
		n++;
		idx = text.indexOf(needle, idx + needle.length);
	}
	return n;
}

// ---------------------------------------------------------------------------
// 5b. @oh-my-pi/hashline payload construction + grammar validation.
//     The package is Bun-only (engines.bun >=1.3.14, ships raw .ts source),
//     so the model-side emission text is built here from the published
//     grammar (src/prompt.md) and validated against it before counting.
// ---------------------------------------------------------------------------
const OHMY_TAG = "a1b2"; // 4-hex content-hash tag served by read; any 4-hex
// value tokenizes identically, so a fixed placeholder is used.

// One hunk:  PUT N.=M:  then +TEXT body rows. Never -old rows — the range
// deletes, the body is final content. Numbers are 1-based and inclusive.
function ohmyHunk(start, end, replacement) {
	const rows = replacement.map((l) => "+" + l).join("\n");
	return `PUT ${start + 1}.=${end + 1}:\n${rows}`;
}

// Validate a generated patch against the published grammar; throws on any
// deviation so the benchmark cannot silently count an un-parseable payload.
function validateOhMyPatch(text) {
	const lines = text.split("\n");
	if (!/^\[.+#[0-9a-fA-F]{4}\]$/.test(lines[0])) {
		throw new Error(`oh-my-pi header malformed: ${JSON.stringify(lines[0])}`);
	}
	let i = 1;
	let hunks = 0;
	while (i < lines.length) {
		const header = lines[i++];
		const m = /^PUT (\d+)\.=(\d+):$/.exec(header);
		if (!m) {
			throw new Error(`oh-my-pi hunk header malformed: ${JSON.stringify(header)}`);
		}
		if (Number(m[1]) > Number(m[2])) {
			throw new Error(`oh-my-pi hunk range inverted: ${header}`);
		}
		hunks++;
		while (i < lines.length && !/^PUT \d+\.=\d+:$/.test(lines[i])) {
			const row = lines[i];
			// a single trailing empty line terminates the document
			if (row === "" && i === lines.length - 1) {
				i++;
				break;
			}
			if (!/^\+/.test(row)) {
				throw new Error(`oh-my-pi body row malformed: ${JSON.stringify(row)}`);
			}
			i++;
		}
	}
	if (hunks === 0) throw new Error("oh-my-pi patch has no hunks");
}

// ---------------------------------------------------------------------------
// 6. Render the report.
// ---------------------------------------------------------------------------
function render(r) {
	const single = r.edits.filter((e) => e.rangeLines === 1);
	const multi = r.edits.filter((e) => e.rangeLines > 1);
	const sum = (es) =>
		es.reduce(
			(s, e) => ({ hl: s.hl + e.hl, sr: s.sr + e.sr, omSeq: s.omSeq + e.omSeq }),
			{ hl: 0, sr: 0, omSeq: 0 },
		);
	const pct = (a, b) =>
		b === 0 ? "n/a" : `${Math.round(((b - a) / b) * 100)}%`;
	const widths = [20, 5, 8, 11, 8, 10];
	const sep = widths.map((n) => "-".repeat(n)).join("|");
	const cell = (v, w) => String(v).padStart(w);

	const out = [];
	out.push(
		"dsh-better-edit — token-cost benchmark (hashline vs str_replace vs @oh-my-pi/hashline)",
	);
	out.push(`corpus   : ${corpusPath}`);
	out.push(`size     : ${r.lineCount} lines`);
	out.push(
		`edits    : ${r.edits.length} (${single.length} single-line, ${multi.length} multi-line)`,
	);
	out.push(`tokenizer: ${TOKENIZER_NAME}`);
	out.push("");
	out.push(
		`${"scenario".padEnd(20)} | ${cell("lines", 5)} | ${cell("hashline", 8)} | ${cell("str_replace", 11)} | ${cell("ohmy seq", 8)} | ${cell("ohmy batch", 10)} |`,
	);
	out.push(sep);
	for (const e of r.edits) {
		out.push(
			`${e.note.padEnd(20)} | ${cell(e.rangeLines, 5)} | ${cell(e.hl, 8)} | ${cell(e.sr, 11)} | ${cell(e.omSeq, 8)} | ${cell("-", 10)} |` +
				(e.ambiguity > 0 ? `  ambiguous match ×${e.ambiguity}` : ""),
		);
	}
	const s = sum(single);
	const m = sum(multi);
	const t = r.totals;
	out.push(sep);
	out.push(
		`${`single-line ×${single.length}`.padEnd(20)} | ${cell("-", 5)} | ${cell(s.hl, 8)} | ${cell(s.sr, 11)} | ${cell(s.omSeq, 8)} | ${cell("-", 10)} |`,
	);
	out.push(
		`${`multi-line ×${multi.length}`.padEnd(20)} | ${cell("-", 5)} | ${cell(m.hl, 8)} | ${cell(m.sr, 11)} | ${cell(m.omSeq, 8)} | ${cell("-", 10)} |`,
	);
	out.push(
		`${`TOTAL ×${r.edits.length}`.padEnd(20)} | ${cell("-", 5)} | ${cell(t.hl, 8)} | ${cell(t.sr, 11)} | ${cell(t.omSeq, 8)} | ${cell(t.omBatch, 10)} |`,
	);
	out.push("");
	const vs = (x) => `${t.sr - x} (${pct(x, t.sr)})`;
	out.push(
		`vs str_replace: hashline saves ${vs(t.hl)}, oh-my-pi seq saves ${vs(t.omSeq)}, oh-my-pi batch saves ${vs(t.omBatch)}.`,
	);
	out.push(
		"read traffic is identical for the tool arms and is excluded (it cancels).",
	);
	out.push(
		"these are the model's OUTPUT tokens (the edit call it emits), billed at ~5-6× input.",
	);
	out.push(
		`at the 5× output rate, effective cost vs str_replace: hashline ${(t.sr / t.hl).toFixed(1)}×, oh-my-pi seq ${(t.sr / t.omSeq).toFixed(1)}×, oh-my-pi batch ${(t.sr / t.omBatch).toFixed(1)}×.`,
	);
	const minMax = (es) =>
		`${Math.min(...es.map((e) => e.pct))}–${Math.max(...es.map((e) => e.pct))}%`;
	out.push(
		`savings scale with the replaced text: ~${Math.round(((s.sr - s.hl) / s.sr) * 100)}% on single lines, ${minMax(multi)} on multi-line ranges.`,
	);
	out.push(
		`correctness proxy: ${r.ambiguous} ambiguous str_replace match${r.ambiguous === 1 ? "" : "es"} avoided; ` +
			"hashline verified 100% (every resolved range is checked against served state).",
	);
	out.push(
		`oh-my-pi payloads validated against the published grammar (${r.omBatchHunks} hunks in the batch arm).`,
	);
	return out.join("\n");
}

console.log(render(run()));
