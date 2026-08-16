#!/usr/bin/env node
/**
 * Publish gate — enforces the tag-first release procedure.
 *
 * Runs from the `prepublishOnly` lifecycle script. `npm publish` refuses to
 * proceed unless the current package.json version already has an annotated
 * `vX.Y.Z` git tag, i.e. unless it went through `npm run release -- X.Y.Z`
 * (which bumps, moves the CHANGELOG [Unreleased] section, commits, tags, and
 * pushes — the tag push creates the GitHub release).
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
  console.error("[assert-tagged] cannot read the version from package.json:", error.message.split("\n")[0]);
  process.exit(1);
}

const tag = `v${version}`;
let local;
try {
  local = execFileSync("git", ["tag", "-l", tag], { cwd: root, encoding: "utf8" }).trim();
} catch (error) {
  console.error("[assert-tagged] git tag lookup failed:", error.message.split("\n")[0]);
  process.exit(1);
}

if (local !== tag) {
  console.error(
    `[assert-tagged] ${tag} is not tagged — publish blocked.\n` +
      `Release first: npm run release -- ${version}   (bumps, moves the CHANGELOG, commits, tags, pushes, creates the GitHub release)\n` +
      `then run npm publish again.`,
  );
  process.exit(1);
}

console.log(`[assert-tagged] ${tag} tagged — publish allowed ✓`);
