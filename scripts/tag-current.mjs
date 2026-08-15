#!/usr/bin/env node
/**
 * Tag the current HEAD with v<version> from package.json and push it, unless
 * the tag already exists. Wired as the `postpublish` lifecycle script so every
 * successful `npm publish` keeps the git tag in sync with the npm version; a
 * GitHub Actions workflow (`.github/workflows/release.yml`) turns the pushed
 * tag into a GitHub release with generated notes.
 *
 * Skips silently when npm runs in --dry-run mode (no tag for an unpublished
 * version), and never overwrites an existing tag — publish a bumped version
 * again instead.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let version;
try {
	version = JSON.parse(
		readFileSync(join(root, "package.json"), "utf8"),
	).version;
} catch (error) {
	console.error(
		"[tag-current] cannot read the version from package.json:",
		error.message.split("\n")[0],
	);
	process.exit(1);
}

if (process.env.npm_config_dry_run) {
	console.log(`[tag-current] dry-run: would tag v${version} — skipping`);
	process.exit(0);
}

function run(args) {
	try {
		return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
	} catch (error) {
		console.error(
			`[tag-current] git ${args.join(" ")} failed:`,
			error.message.split("\n")[0],
		);
		process.exit(1);
	}
}

const tag = `v${version}`;
const existing = run(["tag", "-l", tag]);
if (existing === tag) {
	console.log(`[tag-current] tag ${tag} already exists — nothing to do`);
	process.exit(0);
}

run(["tag", "-a", tag, "-m", `${tag} — dsh-better-edit ${version}`]);
run(["push", "origin", tag]);
console.log(`[tag-current] tagged and pushed ${tag}`);
