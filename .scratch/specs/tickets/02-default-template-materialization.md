## Parent

# 7 ([Enhancement] Support Configurable Prompts to Improve Plugin Flexibility) · Spec: #8

## What to build

On first run the plugin materializes the `_default/` guidance template directory into its shared home: the four section files rendered from the compiled constants, plus a `README.md` explaining the copy-to-override convention. Idempotent — never rewrites files that already exist. The `_default/` layer is both the copy source for users (`cp -r _default <preset>`) and a live global fallback layer (already honoured by the resolver).

## Acceptance criteria

- [ ] An idempotent `ensureDefaultGuidance(homeDir)`-style function creates `_default/{read,edit,batch_edit,undo_last_edit}.md` from the compiled constants when the directory is absent.
- [ ] Existing files are never rewritten (a user-edited `_default/` survives repeated calls).
- [ ] A `README.md` in `_default/` documents the convention: copy to `<preset>/`, front-matter `order`, fallback chain.
- [ ] The template directory name is `_default` (not `default`), so it can never collide with a real preset id.
- [ ] Unit tests cover create-on-missing, no-op on existing, and content parity with the compiled render; the existing vitest suite stays green.

## Blocked by

#9 — guidance resolution core
