# Beads in phoenix

This repo's beads database (prefix `px`) holds the work an agent is doing
right now. It is not a backlog, and nothing in it is the only record of
anything.

| Where | What lives there |
|---|---|
| **Linear**, team `GOO` | Every feature and bug, and anything a person should prioritise. Label it `Repo` › `phoenix` plus `Feature`, `Bug` or `Improvement`. |
| **beads** | What an agent is executing now: the steps of a multi-step task. |
| **Notion** | The business record: CRM, Activity ledger, contacts' dates. |
| **GitHub** | Code and pull requests. Never issues. |

The rule: if a person should prioritise it, it goes in Linear. If an agent
is doing it now, it goes in beads.

## When to use beads

- **Work that can outlive your session or be shared between agents.**
  Make an epic, one child per step, and `blocks` edges where order matters.
  If the work comes from a Linear issue, link it:
  `bd create "..." -t epic --external-ref <Linear issue URL>`.
- **Work that fits in one session.** Your harness's own todo list is fine.
- **A bug or feature you find along the way.** File it in Linear, not as a
  bead. A bead is closed when the work is done; a finding must survive.

## Commands

```bash
bd ready                          # what can be worked now
bd update <id> --claim            # take it (atomic)
bd create "Title" -t task --parent <epic> --description "..."
bd dep add <later> <earlier>      # <later> waits for <earlier>
bd close <id> --reason "..."      # done
bd remember "fact"                # a durable fact about this repo's systems
```

Use `--json` when you parse output. Never use `bd edit`; it opens an editor.

## Sync

The database is local to this machine (`dolt.local-only`): there is no
`bd dolt push` or `pull`, and nothing to sync at the end of a session.
Every worktree of this repo shares the one database.
