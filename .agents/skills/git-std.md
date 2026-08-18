# Git standard

The repo's way of working with Git and GitHub when cooperating.

## Resolve issues by PR, then merge

An issue is resolved by a **pull request**, never by pushing straight to `main`. Every PR is the unit of cooperation — it keeps `main` reviewable and gives each change a reviewable surface.

1. Work on a branch off `main`.
2. Open the PR against `main`.
3. Reference the issue in the body — `Closes #NN` when the PR fully resolves it, `Part of #NN` for a step in a chain.
4. Review, then merge.
5. The merge closes the referenced issue automatically.

Put the `Closes`/`Part of` line at the end of the PR body so GitHub's autoclose fires on merge.

## Scope of the rule

`main`-only pushes are reserved for changes too small to justify a PR — a one-off doc fix, a typo — and even then, prefer a PR when a second pair of eyes adds value. Everything that resolves or moves an issue goes through a PR.
