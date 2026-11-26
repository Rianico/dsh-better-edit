/**
 * Promotes the curated `## [Unreleased]` ledger into the release.
 *
 * `@semantic-release/changelog` regenerated the notes from commit subjects, which discarded the
 * curated ledger and prepended them *above* `## [Unreleased]`, inverting Keep-a-Changelog order.
 * Here `generateNotes` returns the curated block and `prepare` promotes it to
 * `## [version] - date` with a fresh empty `## [Unreleased]` above it. semantic-release v25 calls
 * `generateNotes` twice — `@semantic-release/git` commits the CHANGELOG, which regenerates the
 * notes — so the first result is cached and the ledger survives the second call. An empty block is
 * not an error: a landing can carry no entry, so the section is promoted empty.
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

/** The curated notes captured while `[Unreleased]` was still populated, held across regeneration. */
let cachedNotes = null;

export async function generateNotes(pluginConfig, context) {
  if (cachedNotes !== null) {
    return cachedNotes;
  }
  const { body } = split(await readFile(changelogPath(pluginConfig, context), "utf8"));
  cachedNotes = body || EMPTY_NOTES;
  return cachedNotes;
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
