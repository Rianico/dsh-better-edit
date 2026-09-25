/**
 * Promote the curated `## [Unreleased]` ledger into the release.
 *
 * `@semantic-release/changelog` regenerated the notes from commit subjects, which discarded the
 * curated ledger at the moment it mattered and prepended the regenerated text *above*
 * `## [Unreleased]` — inverting Keep-a-Changelog order. This plugin makes the ledger the source
 * instead, so curation survives into the file and the GitHub release:
 *
 * - `generateNotes` returns the curated block, so the release notes are what a human wrote.
 * - `prepare` promotes it to `## [version] - date` and re-opens an empty `## [Unreleased]` above.
 *
 * `generateNotes` runs before `prepare` in the pipeline, so the notes are read while the block is
 * still unreleased.
 *
 * An empty block is not an error. A landing can carry no entry — a direct push to `main`, say — and
 * blocking a release on a bookkeeping gap is worse than releasing without user-facing text, so the
 * section is promoted empty and the note says so.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const UNRELEASED = "## [Unreleased]";
const NEXT_SECTION = /^## \[/m;
const EMPTY_NOTES = "No user-facing changes.";

/** Split the ledger into the header, the unreleased body, and everything already released. */
function split(content) {
  const start = content.indexOf(UNRELEASED);
  if (start === -1) {
    throw new Error(`release-changelog: CHANGELOG.md has no '${UNRELEASED}' heading to promote`);
  }
  const after = content.slice(start + UNRELEASED.length);
  const next = after.search(NEXT_SECTION);
  return {
    head: content.slice(0, start),
    body: (next === -1 ? after : after.slice(0, next)).trim(),
    released: next === -1 ? "" : after.slice(next),
  };
}

function changelogPath(pluginConfig, context) {
  return join(context.cwd ?? process.cwd(), pluginConfig.changelogFile ?? "CHANGELOG.md");
}

export async function generateNotes(pluginConfig, context) {
  const { body } = split(await readFile(changelogPath(pluginConfig, context), "utf8"));
  return body || EMPTY_NOTES;
}

export async function prepare(pluginConfig, context) {
  const path = changelogPath(pluginConfig, context);
  const { head, body, released } = split(await readFile(path, "utf8"));
  const version = context.nextRelease.version;
  const date = new Date().toISOString().slice(0, 10);
  const heading = `## [${version}] - ${date}`;
  const promoted = body ? `${UNRELEASED}\n\n${heading}\n\n${body}` : `${UNRELEASED}\n\n${heading}`;
  const content = `${head}${promoted}\n\n${released}`;
  await writeFile(path, `${content.trimEnd()}\n`, "utf8");
}
