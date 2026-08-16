/**
 * Release orchestration — the tag-first publish procedure.
 *
 *   npm run release -- 0.2.0 [--dry-run]
 *
 * 1. Validates X.Y.Z, requires a clean working tree, and refuses if the
 *    vX.Y.Z tag already exists.
 * 2. Bumps `version` in package.json and package-lock.json.
 * 3. Moves the CHANGELOG `[Unreleased]` section to `[X.Y.Z] - <date>`
 *    (creating it if absent) and re-adds an empty `[Unreleased]`.
 * 4. Commits ("chore: release vX.Y.Z"), tags (annotated vX.Y.Z), pushes
 *    the branch and the tag.
 * 5. The v* tag push triggers .github/workflows/release.yml, which creates
 *    the GitHub release from the changelog section.
 * 6. Prints the remaining step: npm publish (needs a browser OTP).
 *
 * `npm publish` is guarded by scripts/assert-tagged.mjs (prepublishOnly), so
 * a version can only be published after it has been tagged and released.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { moveUnreleased } from "./changelog.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const requested = args.find((a) => !a.startsWith("--"));

function run(args, opts = {}) {
	if (dryRun) {
		console.log(`[dry-run] git ${args.join(" ")}`);
		return "";
	}
	try {
		return execFileSync("git", args, {
			cwd: root,
			encoding: "utf8",
			...opts,
		}).trim();
	} catch (error) {
		console.error(
			`git ${args.join(" ")} failed:`,
			error.message.split("\n")[0],
		);
		process.exit(1);
	}
}

function fail(message) {
	console.error(`[release] ${message}`);
	process.exit(1);
}

// --- 1. validate -----------------------------------------------------------
if (!/^\d+\.\d+\.\d+$/.test(requested ?? "")) {
	fail(
		"usage: npm run release -- <X.Y.Z> [--dry-run]   (e.g. npm run release -- 0.2.0)",
	);
}
let pkg;
try {
	pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
} catch (error) {
	fail(`cannot read package.json: ${error.message.split("\n")[0]}`);
}
const current = pkg.version;
const next = requested;
const cmp = (a, b) => {
	const [am, an, ap] = a.split(".").map(Number);
	const [bm, bn, bp] = b.split(".").map(Number);
	return am - bm || an - bn || ap - bp;
};
if (cmp(next, current) <= 0) {
	fail(`version ${next} is not newer than the current ${current}`);
}

const dirty = run(["status", "--porcelain"]);
if (dirty) {
	fail(`working tree is not clean — commit or stash first:\n${dirty}`);
}
const existingTag = run(["tag", "-l", `v${next}`]);
if (existingTag === `v${next}`) {
	fail(`tag v${next} already exists`);
}

// --- 2. bump version -------------------------------------------------------
const lockPath = join(root, "package-lock.json");
let lock;
try {
	lock = JSON.parse(readFileSync(lockPath, "utf8"));
} catch (error) {
	fail(`cannot read package-lock.json: ${error.message.split("\n")[0]}`);
}
if (!dryRun) {
	writeFileSync(
		join(root, "package.json"),
		`${JSON.stringify({ ...pkg, version: next }, null, 2)}\n`,
	);
	writeFileSync(
		lockPath,
		`${JSON.stringify({ ...lock, version: next }, null, 2)}\n`,
	);
}
console.log(`version ${current} → ${next}`);

// --- 3. CHANGELOG: move [Unreleased] → [X.Y.Z] - <date> --------------------
const changelogPath = join(root, "CHANGELOG.md");
const changelog = readFileSync(changelogPath, "utf8");
const today = new Date().toISOString().slice(0, 10);
const moved = moveUnreleased(changelog, next, today);
if (!dryRun) writeFileSync(changelogPath, moved);
console.log(`CHANGELOG: [Unreleased] → [${next}] - ${today}`);

// --- 4. commit + tag -------------------------------------------------------
run(["add", "package.json", "package-lock.json", "CHANGELOG.md"]);
run(["commit", "-m", `chore: release v${next}`]);
run(["tag", "-a", `v${next}`, "-m", `v${next} — dsh-better-edit ${next}`]);

// --- 5. push (tag push triggers the GitHub release workflow) ---------------
const branch = run(["branch", "--show-current"]) || "main";
run(["push", "origin", branch]);
run(["push", "origin", `v${next}`]);

// --- 6. next step ----------------------------------------------------------
console.log("");
console.log(
	`released v${next}: commit pushed, GitHub release created from the changelog.`,
);
console.log(
	`next: npm publish --registry https://registry.npmjs.org   (requires browser OTP; blocked until the tag exists)`,
);
