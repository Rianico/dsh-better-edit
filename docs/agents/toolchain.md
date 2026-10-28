# Toolchain

Detected CLI toolchain for `dsh-better-edit`. Missing tools fall back to the listed alternative.

| Tool           | Status | Fallback                    |
| -------------- | ------ | --------------------------- |
| `adr`          | found  | manual directory + template |
| `fd`           | found  | find                        |
| `rg`           | found  | grep                        |
| `eza`          | found  | ls / tree                   |
| `wt`           | found  | git worktree                |
| `uv`           | found  | pip / python -m venv        |
| `oxlint`       | found  | ruff / eslint               |
| `oxfmt`        | found  | prettier                    |
| `basedpyright` | found  | pyright / mypy              |

Prefer the found tool. When a tool is missing, use its fallback and note the gap
rather than silently changing the workflow.
