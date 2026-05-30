# tasks/

Active work for the Timed Trading repo.

## Files

- **[todo.md](todo.md)** — current live work. Update at session start
  and before any non-trivial change.
- **[lessons.md](lessons.md)** — long-form lessons + post-mortems. Add to
  this every time the user corrects you, even on small things. The
  one-line summary also goes into `../CONTEXT.md`.
- **[lessons-archive.md](lessons-archive.md)** — older lessons rolled
  out of the main file for readability.
- **`2026-05-*-*.md`** — strategic plans for shipped or in-flight features.
  Keep as historical reference; do not edit after a feature has shipped.
- **`scripts/`** — task-scoped helper scripts (performance analyses, etc.).

## Folders

- **[archive/](archive/)** — older plans, post-mortems, and superseded
  designs. The bulk is in `archive/2026-pre-may/` (V11-V16, Jul→Apr
  recovery, phase A-G calibrations, etc.). **Jul→Apr recovery is complete**
  (engine promoted to live) — see `archive/2026-pre-may/README.md`. Don't
  grep this folder when triaging current work.

## When to add what here

| Doing… | Goes in… |
|---|---|
| Planning a multi-step feature | New `YYYY-MM-DD-<slug>.md` |
| Captured a user correction | `lessons.md` (and one-line to `../CONTEXT.md`) |
| Day-to-day work item | `todo.md` |
| Reusable how-to (deploy, backfill, rescore, ...) | NOT here — see [`../skills/`](../skills/) |
| Long-form architectural doc | NOT here — see [`../docs/`](../docs/) |

## Workflow link

[`../AGENTS.md`](../AGENTS.md) is the onboarding entry point. Read it first
if you're new to this repo.
