/**
 * CHANGELOG transform used by the release script.
 *
 * `moveUnreleased(changelog, version, date)` renames the `## [Unreleased]`
 * section to `## [X.Y.Z] - <date>` (kept in place, entries preserved) and
 * re-adds an empty `## [Unreleased]` above it. When no `[Unreleased]`
 * section exists, it inserts both a fresh `[Unreleased]` and the version
 * section before the first existing version header.
 */
export function moveUnreleased(changelog, version, date) {
  const header = "## [Unreleased]";
  const idx = changelog.indexOf(header);
  if (idx === -1) {
    // no Unreleased section — insert a fresh one plus the version section
    // before the first existing version header
    const first = changelog.indexOf("## [");
    const fresh = `${header}\n\n## [${version}] - ${date}\n\n`;
    return changelog.slice(0, first) + fresh + changelog.slice(first);
  }
  const rest = changelog.slice(idx + header.length);
  return changelog.slice(0, idx) + `${header}\n\n## [${version}] - ${date}${rest}`;
}
