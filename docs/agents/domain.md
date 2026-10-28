# Domain Docs

How the engineering skills consume the dsh-better-edit domain documentation.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root — the ubiquitous-language glossary.
- **`docs/adr/`** — read ADRs that touch the area you are about to work in.

If any of these files do not exist, proceed silently. Do not flag their absence.

## Use the glossary vocabulary

When output names a domain concept (issue title, refactor proposal, test name),
use the term as defined in `GLOSSARY.md`. Do not drift to synonyms the glossary avoids.
A concept missing from the glossary is a signal: either the language is invented
or a real gap exists — note it for brainstorming.

## Flag ADR conflicts

If output contradicts an existing ADR, surface it explicitly rather than silently overriding.

## ADR CLI setup

Initialize ADRs with the canonical directory:

```bash
adr init docs/adr
```
