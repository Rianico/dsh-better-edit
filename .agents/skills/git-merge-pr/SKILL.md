---
name: git-merge-pr
description: Supersede or land a fork PR while keeping its author as contributor. Use when a PR comes from a fork you can't push to, when the temp branch must be pr_prefix/<num>-<suffix>, or when a squash merge must carry Co-authored-by so the external author enters the contributors graph.
---

# git-merge-pr — supersede with contributor preservation

Provenance: `pi-interactive-shell#33(493e19)` → `fixup a91c3ff` → `#34(backlog/pr33-*)` squash `54716c4←c5dac78`. Same shape used `dsh-better-edit#26(f73fdfc)` → `fix/pr26-preserve-utf8-bom(36379ce)` → `#27` squash `244cbe6`.

## When

- Fork PR you can't push to — need own branch at its OID.
- Original **author must become contributor** on `main` (squash loses ancestry, `Co-authored-by` is the only attribution).
- Team requires `pr_prefix/<pr num>-pr_appendix` (e.g. `fix/pr26-preserve-utf8-bom`) for the temp branch.

## Steps — tight supersede

Do them in order. Each step ends on its check.

### 1. Pin the fork head

```bash
git fetch origin
git fetch origin pull/<N>/head
git log --oneline FETCH_HEAD -n 3
gh pr view <N> --json author,headRefName,title --jq .
git log FETCH_HEAD -1 --format="%an <%ae>"
```

Done when `FETCH_HEAD` resolves and author email captured for trailer.

### 2. Create temp branch at OID

```bash
git checkout -b pr_prefix/<N>-<suffix> FETCH_HEAD
# worktree variant: git worktree add ../w-pr<N>-<suffix> -b pr_prefix/<N>-<suffix> FETCH_HEAD
```

Done when `git log --oneline -n1` shows the fork's OID as parent. Preserve OID/authorship — don't rebase.

> [!tip] Branch format
> `pr_prefix` is your lane (`fix`/`feat`/`backlog`), `<N>` is the superseded number, `<suffix>` is the appendix. Example: `fix/pr26-preserve-utf8-bom`.

### 3. Verify incoming

```bash
git diff --check origin/main...HEAD
npm run typecheck && npm test   # or targeted: npx vitest run <files>
```

Done when diff is clean and checks are green — don't fixup a broken base.

### 4. Apply refinement

Edit, then:

```bash
npm run typecheck && npm test && npm run build
git diff --check
```

Done when full suite green and no whitespace errors.

### 5. Commit fixup with trailer

```bash
git add <files>
git commit -m "refine: <what>

Co-authored-by: <PR Author> <email>"
```

Done when `git show -s HEAD` lists your message + `Co-authored-by` line for the fork author. Keep fixup atomic — don't mix unrelated changes.

> [!note] Trailer shape
> Exact `Co-authored-by: Name <email>` per line, GitHub counts it. Squash later also carries it — double-ensures contributor graph.

### 6. Push and open superseder

```bash
git push -u origin pr_prefix/<N>-<suffix>
gh pr create --base main --head pr_prefix/<N>-<suffix> \
  --title "fix: <msg> (supersedes #<N>)" \
  --body "Supersedes #<N> — <one-line hardening>.

Original: <OID> by @<login>
Fixup: <newOID>

Supersedes #<N>
Closes #<issue>"
```

Done when `gh pr view --json number,headRefName` shows new PR.

### 7. Land as squash — keep contributor

Squash creates a **new single-parent** commit on `main`; fork OID is not an ancestor, so attribution rides on the message:

```bash
cat > /tmp/body.txt <<'EOF'
Supersedes #<N> — <hardening>

Original: <OID> by <author>
Fixup: <fixupOID>

Closes #<issue>

Co-authored-by: <PR Author> <email>
Co-authored-by: <you> <email>
EOF
gh pr merge <newN> --squash --delete-branch --subject "fix: <msg> (#<newN>)" --body-file /tmp/body.txt
```

Or local:

```bash
git checkout main && git pull --ff-only
git merge --squash pr_prefix/<N>-<suffix>
git commit -m "fix: <msg> (#<newN>)

Supersedes #<N>
Closes #<issue>

Co-authored-by: <PR Author> <email>
Co-authored-by: <you> <email>"
git push origin main
```

Done when `git show -s --format=%B <mergeOID>` on `origin/main` lists both OIDs and both `Co-authored-by` lines. Verify `gh api repos/:owner/:repo/commits/<OID> --jq .commit.message` contains them.

> [!warning] `--no-ff` vs `squash`
> `squash` gives linear `main` (as #34/ #27 did) — needs trailers. `--no-ff` keeps two parents and preserves author automatically, but clutters `first-parent` history. Default to `squash`.

### 8. Close superseded and clean

```bash
gh pr close <N> --comment "Superseded by #<newN> — merged as <mergeOID>."
git branch -d pr_prefix/<N>-<suffix>   # or git worktree remove ../w-pr<N>-<suffix>
git checkout main && git pull --ff-only
```

Done when `gh pr view <N> --json state` is `CLOSED`, new PR `MERGED`, and local branch/worktree gone.

## Completion

- [ ] `origin/main` contains one squash `mergeOID` parent `main`, message has `Supersedes #<N>`, `Closes #<issue>`, both `Co-authored-by`
- [ ] `gh api commits/<mergeOID>` shows trailers → external author in contributors graph
- [ ] Superseded `#<N>` closed with pointer to `#<newN>`
- [ ] Temp `pr_prefix/<N>-<suffix>` deleted locally and remotely
