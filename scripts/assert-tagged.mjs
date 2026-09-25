#!/usr/bin/env node
/**
 * Publish gate — enforces the tag-first discipline around the automated release.
 *
 * Runs from the `prepublishOnly` lifecycle script. `npm publish` refuses to
 * proceed unless the current package.json version already has a `vX.Y.Z` git
 * tag — i.e. unless semantic-release cut that version on `main` (dispatching
 * `.github/workflows/release.yml` bumps, promotes the curated CHANGELOG
 * ledger, commits, tags, and creates the GitHub release). `npmPublish` stays
 * false in `.releaserc.json`, so publishing a cut version remains a human step.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

let version;
try {
  version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
} catch (error) {
  console.error(
    "[assert-tagged] cannot read the version from package.json:",
    error.message.split("\n")[0],
  );
  process.exit(1);
}

const tag = `v${version}`;
let local;
try {
  local = execFileSync("git", ["tag", "-l", tag], {
    cwd: root,
    encoding: "utf8",
  }).trim();
} catch (error) {
  console.error("[assert-tagged] git tag lookup failed:", error.message.split("\n")[0]);
  process.exit(1);
}

if (local !== tag) {
  console.error(
    `[assert-tagged] ${tag} is not tagged — publish blocked.\n` +
      `Release first: dispatch .github/workflows/release.yml (semantic-release) so ${tag} is cut and tagged on main\n` +
      `then run npm publish again.`,
  );
  process.exit(1);
}

console.log(`[assert-tagged] ${tag} tagged — publish allowed ✓`);
