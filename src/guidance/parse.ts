/**
 * Pure parser for per-preset guidance override files.
 *
 * Only a leading `---` fence whose lines are empty or `order: <integer>` is
 * accepted. This module has zero IO — exhaustive unit testing without a temp
 * home.
 * @module dsh-better-edit/guidance/parse
 */

/** The parsed content of one override file. */
export interface ParsedSection {
	/** Front-matter `order`, when present and valid. */
	order?: number;
	/** The section text: the file body, or the whole file when no fence is present. */
	text: string;
	/** True when a leading `---` fence is present but does not parse (fast fail). */
	malformed?: boolean;
	/** Human-readable parse reason, present only when `malformed` is true. */
	reason?: string;
}

function stripCR(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function startsWithFenceLine(content: string): boolean {
	return stripCR(content.split("\n")[0]!) === "---";
}

/**
 * Parse an override file. Only a leading `---` fence whose lines are empty or
 * `order: <integer>` is accepted. A leading `---` that does not parse (no
 * closing fence, unknown key, non-integer value) is a malformed override;
 * anything else is pure prose (the whole file as text).
 */
export function parseSectionFile(content: string): ParsedSection {
	const lines = content.split("\n");
	if (stripCR(lines[0] ?? "") !== "---") {
		return { text: content };
	}
	const close = lines.findIndex(
		(line, index) => index > 0 && stripCR(line) === "---",
	);
	if (close < 0) {
		return { text: content, malformed: true, reason: "missing closing fence" };
	}
	let order: number | undefined;
	for (let index = 1; index < close; index++) {
		const line = stripCR(lines[index]!);
		if (line.trim() === "") continue;
		const key = line.split(":")[0]!.trim();
		const match = /^order:\s*(-?\d+)\s*$/.exec(line);
		if (!match) {
			if (key === "order") {
				const value = line.slice(line.indexOf(":") + 1).trim();
				return {
					text: content,
					malformed: true,
					reason: `non-integer order '${value}'`,
				};
			}
			return {
				text: content,
				malformed: true,
				reason: `unknown key '${key}'`,
			};
		}
		order = Number.parseInt(match[1] as string, 10);
	}
	// Front-matter body: strip leading blank lines after the closing fence so
	// `---\n…\n---\n\nbody` and `---\n…\n---\nbody` parse identically (the
	// materialized preset files carry a blank line after the fence).
	const body = lines.slice(close + 1);
	let bodyStart = 0;
	while (bodyStart < body.length && body[bodyStart]!.trim() === "") bodyStart++;
	return { order, text: body.slice(bodyStart).join("\n") };
}

/**
 * True when an override file is blank: whitespace-only body and NO front-matter
 * fence (the "I want the default" case). The single source of truth for whether
 * a boot-time materialization pass should re-seed a file. False for prose with
 * content, for any valid fence (including a keyless/empty one — a deliberate
 * blank), and for malformed files.
 */
export function isBlankOverride(content: string): boolean {
	const parsed = parseSectionFile(content);
	return (
		!parsed.malformed &&
		parsed.order === undefined &&
		parsed.text.trim() === "" &&
		!startsWithFenceLine(content)
	);
}

/** True when an override file opens with a leading `---` fence that is malformed. */
export function isMalformedOverride(content: string): boolean {
	return parseSectionFile(content).malformed === true;
}
