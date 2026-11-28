# Documentation index

Start here when you need the repository's decision record, not the API docs.

| Document                                                     | What it answers                                                                                                   |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| [`adr/`](adr/)                                               | Why a behavior exists. Numbered decision records, newest first by number.                                         |
| [`absorption-plan.md`](absorption-plan.md)                   | What was absorbed from `pi-better-edit`, per commit and per lane.                                                 |
| [`divergence-from-upstream.md`](divergence-from-upstream.md) | Where this repo intentionally differs from upstream, with a stable `D-*` register and reproduction commands.      |
| [`dsh-unique-design.md`](dsh-unique-design.md)               | Designs this repo owns because the host is dsh: ownership, reclaim, guidance, fs policy, encoding, store tenancy. |
| [`specs/`](specs/)                                           | Research and architecture notes that feed ADRs (encoding, store tenancy, install isolation).                      |
| [`agents/`](agents/)                                         | Toolchain, issue tracker, triage labels, and the environment snapshot.                                            |

The top-level `README.md` is user-facing. `GLOSSARY.md` is the shared vocabulary.

## Maintenance

- A behavior change lands with an ADR. If it changes the upstream contract, also update the
  divergence ledger.
- An upstream sync updates `AGENTS.md` (cursor), `absorption-plan.md` (per-commit verdicts),
  and `divergence-from-upstream.md` (pins and backlog count).
- A new host-owned seam gets a dossier entry in `dsh-unique-design.md` when it has no upstream
  counterpart.
