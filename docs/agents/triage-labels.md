# Triage Labels

The skills speak in terms of two kinds of triage role: a **category** (what
the issue is) and a **state** (where it is in the triage machine). This file
maps each role to the label string used in this repo's issue tracker, and
lists the tracker's other labels so they are not mistaken for triage roles.

Every triaged issue carries exactly one category label and one state label.

## Category roles

| Role          | Label           | Meaning                            |
| ------------- | --------------- | ---------------------------------- |
| `bug`         | `bug`           | Something is broken                |
| `enhancement` | `enhancement`   | New feature or improvement         |
| (repo-local)  | `documentation` | Documentation-only change or defect |

`documentation` is a repo-local category with no canonical role name. Use it
instead of `bug`/`enhancement` when the work touches only docs — for example
a README claim that no longer matches the code.

## State roles

| Role              | Label             | Meaning                    |
| ----------------- | ----------------- | -------------------------- |
| `needs-triage`    | `needs-triage`    | Maintainer must evaluate   |
| `needs-info`      | `needs-info`      | Waiting on the reporter    |
| `ready-for-agent` | `ready-for-agent` | Fully specified, AFK-ready |
| `ready-for-human` | `ready-for-human` | Needs human implementation |
| `wontfix`         | `wontfix`         | Will not be actioned       |

## Other labels

These exist in the tracker but are not triage roles. Never use one as a
substitute for a category or state label:

`accessibility`, `duplicate`, `good first issue`, `help wanted`, `invalid`,
`question`, `released`.

## Maintenance

When a skill mentions a role (for example "apply the AFK-ready triage
label"), use the label string from these tables. When the tracker's
vocabulary changes, update this file in the same change — these tables are
the authoritative mapping.
