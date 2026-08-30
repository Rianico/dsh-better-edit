/**
 * VS Code encoding model — pure helpers for BOM→UTF-8→model-assisted top-3.
 * No jschardet; heuristic scoring + iconv-lite rendering.
 * @module dsh-better-edit/encoding
 */

import iconv from "iconv-lite";

export const SUPPORTED_ENCODINGS = [
	"gbk",
	"big5",
	"shift_jis",
	"euc-kr",
	"windows-1251",
	"iso-8859-1",
] as const;
export type SupportedEncoding = (typeof SUPPORTED_ENCODINGS)[number];

const ALIASES: Record<string, string> = {
	utf8: "utf8",
	utf8bom: "utf8bom",
	utf16le: "utf16le",
	utf16be: "utf16be",
	utf32le: "utf32le",
	utf32be: "utf32be",
	gbk: "gbk",
	gb18030: "gbk",
	gb2312: "gbk",
	big5: "big5",
	shiftjis: "shift_jis",
	shift_jis: "shift_jis",
	sjis: "shift_jis",
	euckr: "euc-kr",
	"euc-kr": "euc-kr",
	windows1251: "windows-1251",
	cp1251: "windows-1251",
	"windows-1251": "windows-1251",
	iso88591: "iso-8859-1",
	"iso-8859-1": "iso-8859-1",
	latin1: "iso-8859-1",
};

/** Canonicalize case-insensitive encoding param, strip -_ . */
export function normalizeEncoding(input: string): string | undefined {
	const key = input.trim().toLowerCase().replace(/[-_]/g, "");
	// need original with dashes for lookup: try both
	const candidates = [key, input.trim().toLowerCase()];
	for (const c of candidates) {
		const v = ALIASES[c] ?? ALIASES[key];
		if (v) return v;
	}
	// also try direct lowercased
	const lower = input.trim().toLowerCase();
	if (ALIASES[lower]) return ALIASES[lower];
	return undefined;
}

export function isSupportedEncoding(enc: string): boolean {
	const norm = normalizeEncoding(enc);
	if (!norm) return false;
	return (SUPPORTED_ENCODINGS as readonly string[]).includes(norm) || ["utf8","utf8bom","utf16le","utf16be","utf32le","utf32be"].includes(norm);
}

export interface BomInfo {
	encoding: string;
	bomLen: number;
	hasBOM: boolean;
}

export function detectBom(bytes: Uint8Array): BomInfo | undefined {
	if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { encoding: "utf8bom", bomLen: 3, hasBOM: true };
	if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0x00 && bytes[3] === 0x00) return { encoding: "utf32le", bomLen: 4, hasBOM: true };
	if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0xfe && bytes[3] === 0xff) return { encoding: "utf32be", bomLen: 4, hasBOM: true };
	if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return { encoding: "utf16le", bomLen: 2, hasBOM: true };
	if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return { encoding: "utf16be", bomLen: 2, hasBOM: true };
	return undefined;
}

export function isValidUtf8(bytes: Uint8Array): boolean {
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return true;
	} catch {
		return false;
	}
}

function printableRatio(text: string): number {
	if (text.length === 0) return 1;
	let printable = 0;
	for (const ch of text) {
		const code = ch.charCodeAt(0);
		if (code === 10 || code === 13 || code === 9) printable += 1;
		else if (code >= 32 && code !== 127) printable += 1;
		else if (code > 127) printable += 1; // non-ascii considered printable if not replacement
	}
	return printable / text.length;
}

function scriptBonus(text: string, enc: string): number {
	let bonus = 0;
	const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
	const cyrillic = (text.match(/[\u0400-\u04ff]/g) || []).length;
	const hiragana = (text.match(/[\u3040-\u309f\u30a0-\u30ff]/g) || []).length;
	const hangul = (text.match(/[\uac00-\ud7af]/g) || []).length;
	if (enc === "gbk" || enc === "big5") bonus += cjk * 5;
	if (enc === "windows-1251") bonus += cyrillic * 2;
	if (enc === "shift_jis") bonus += hiragana * 8;
	if (enc === "euc-kr") bonus += hangul * 4;
	return bonus;
}

function smartSlice(text: string): string {
	// seek first non-ascii char, slice ±32 around it, truncate to 50
	let idx = -1;
	for (let i = 0; i < text.length; i += 1) {
		if (text.charCodeAt(i) > 127) { idx = i; break; }
	}
	if (idx === -1) return text.slice(0, 50);
	const start = Math.max(0, idx - 32);
	const slice = text.slice(start, start + 64);
	return slice.slice(0, 50).replace(/\s+/g, " ").trim();
}

export interface CandidatePreview {
	encoding: string;
	sample: string;
	score: number;
}

export function scoreText(text: string, enc: string): number {
	if (text.includes("\uFFFD")) return -1000;
	const ratio = printableRatio(text);
	if (ratio < 0.85) return -500 + ratio * 10;
	let score = ratio * 10;
	score += scriptBonus(text, enc) * 0.5;
	return score;
}

/** Decode bytes under enc via iconv-lite, return text or undefined on failure. */
export function decodeBytes(bytes: Uint8Array, enc: string): string | undefined {
	try {
		if (enc === "utf8" || enc === "utf8bom") return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		if (enc === "utf16le") return new TextDecoder("utf-16le").decode(bytes);
		if (enc === "utf16be") return new TextDecoder("utf-16be").decode(bytes);
		// iconv-lite for legacy
		return iconv.decode(Buffer.from(bytes), enc);
	} catch {
		return undefined;
	}
}

export function encodeText(text: string, enc: string): Uint8Array | undefined {
	try {
		if (enc === "utf8" || enc === "utf8bom") return new TextEncoder().encode(text);
		if (enc === "utf16le") return new Uint8Array(Buffer.from(text, "utf16le"));
		if (enc === "utf16be") {
			// Node no utf16be, use iconv
			return new Uint8Array(iconv.encode(text, "utf16be"));
		}
		return new Uint8Array(iconv.encode(text, enc));
	} catch {
		return undefined;
	}
}

/** Top-3 candidates for autoGuess: decode each allowlist enc, score, sort. */
export function top3Candidates(bytes: Uint8Array, allowlist: string[]): CandidatePreview[] {
	const candidates: CandidatePreview[] = [];
	// handle BOM case separately? caller should handle BOM before calling.
	for (const raw of allowlist) {
		const enc = normalizeEncoding(raw) ?? raw;
		const text = decodeBytes(bytes, enc);
		if (text === undefined) continue;
		const sample = smartSlice(text);
		const score = scoreText(text, enc);
		candidates.push({ encoding: enc, sample, score });
	}
	candidates.sort((a, b) => b.score - a.score);
	return candidates.slice(0, 3);
}

export function hasReplacementChar(text: string): boolean {
	return text.includes("\uFFFD");
}

/**
 * Try chardet (runk/node-chardet) for autoGuess when available.
 * Dynamically imports 'chardet' (optionalDep) and returns canonical encoding
 * if confidence >=45 and allowlist-accepted and decodable without �.
 * Falls back to heuristic when chardet unavailable/low confidence.
 */
export async function detectWithChardet(bytes: Uint8Array, allowlist: string[]): Promise<string | undefined> {
	try {
		const mod: unknown = await import("chardet");
		// chardet ESM: default export has analyse, CJS: named
		const chardetLike = (mod as Record<string, unknown>).default ?? mod;
		const analyse = (chardetLike as { analyse?: (b: Uint8Array | Buffer) => Array<{ name: string; confidence: number }> }).analyse;
		if (typeof analyse !== "function") return undefined;
		const buf = Buffer.isBuffer(bytes) ? (bytes as Buffer) : Buffer.from(bytes);
		const results = analyse(buf) as Array<{ name: string; confidence: number }>;
		if (!Array.isArray(results) || results.length === 0) return undefined;
		const allowNorm = new Set(allowlist.map((a) => normalizeEncoding(a) ?? a.toLowerCase()));
		for (const r of results) {
			if (typeof r.name !== "string" || typeof r.confidence !== "number") continue;
			if (r.confidence < 45) continue;
			const norm = normalizeEncoding(r.name);
			if (!norm) continue;
			if (!allowNorm.has(norm)) continue;
			// iconv-lite existence check (use try decode)
			const encForCheck = norm;
			if (!iconv.encodingExists(encForCheck) && !iconv.encodingExists(r.name)) continue;
			const text = decodeBytes(bytes, encForCheck);
			if (text === undefined) continue;
			if (text.includes("\uFFFD")) continue;
			// extra guard: printable ratio
			if (text.length > 0) {
				let printable = 0;
				for (const ch of text) {
					const c = ch.charCodeAt(0);
					if (c === 10 || c === 13 || c === 9) printable += 1;
					else if (c >= 32 && c !== 127) printable += 1;
					else if (c > 127) printable += 1;
				}
				if (printable / text.length < 0.85) continue;
			}
			return norm;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
/**
 * Chardet-based Top-3 for E_NOT_TEXT (primary) and autoGuess.
 * Returns chardet candidates filtered by allowlist and decodable, else empty.
 */
export async function chardetTop3Candidates(bytes: Uint8Array, allowlist: string[]): Promise<Array<{ encoding: string; confidence: number; sample: string }>> {
  try {
    const mod: unknown = await import("chardet");
    const chardetLike = (mod as Record<string, unknown>).default ?? mod;
    const analyse = (chardetLike as { analyse?: (b: Uint8Array | Buffer) => Array<{ name: string; confidence: number }> }).analyse;
    if (typeof analyse !== "function") return [];
    const buf = Buffer.isBuffer(bytes) ? (bytes as Buffer) : Buffer.from(bytes);
    const results = analyse(buf) as Array<{ name: string; confidence: number }>;
    if (!Array.isArray(results) || results.length === 0) return [];
    const allowNorm = new Set(allowlist.map((a) => normalizeEncoding(a) ?? a.toLowerCase()));
    const out: Array<{ encoding: string; confidence: number; sample: string }> = [];
    for (const r of results) {
      if (typeof r.name !== "string" || typeof r.confidence !== "number") continue;
      const norm = normalizeEncoding(r.name);
      if (!norm) continue;
      if (!allowNorm.has(norm)) continue;
      if (!iconv.encodingExists(norm) && !iconv.encodingExists(r.name)) continue;
      const text = decodeBytes(bytes, norm);
      if (text === undefined) continue;
      if (text.includes("\uFFFD")) continue;
      const sample = (() => {
        let idx = -1;
        for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) > 127) { idx = i; break; }
        if (idx === -1) return text.slice(0, 50);
        const start = Math.max(0, idx - 32);
        return text.slice(start, start + 64).slice(0, 50).replace(/\s+/g, " ").trim();
      })();
      out.push({ encoding: norm, confidence: r.confidence, sample });
      if (out.length >= 3) break;
    }
    return out;
  } catch {
    return [];
  }
}

export async function getTop3Candidates(bytes: Uint8Array, allowlist: string[]): Promise<CandidatePreview[]> {
  const chardetCands = await chardetTop3Candidates(bytes, allowlist);
  if (chardetCands.length > 0) {
    return chardetCands.map((c) => ({ encoding: c.encoding, sample: c.sample, score: c.confidence }));
  }
  return top3Candidates(bytes, allowlist);
}

