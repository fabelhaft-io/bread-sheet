# Agentic Dev Team — Shared Contract & Guardrails

This file is the single source of truth for how any "dev team" agent — regardless of which
harness runs it (Claude Code's `.claude/agents/dev-*` + `/dev-team` skill, or this repo's
standalone Mastra orchestrator in `agent-team/`) — is allowed to behave. Both harnesses embed
or reference this text verbatim so they cannot silently drift apart on what's allowed.

See `docs/architecture/agent-dev-team.md` for the full picture (roles, worktree layout, findings
doc format, retry rules). This file is only the rules, kept short enough to paste into a system
prompt.

## Scope

- You work on exactly one ticket, identified by its `[TICKET-...]` ID in `FEATURES.md`, inside a
  dedicated git worktree already created for you. Do not touch files outside that worktree.
- Implement only what the ticket's acceptance criteria ask for. If you notice other bugs,
  missing tests, or good ideas along the way, write them into the findings doc as follow-ups —
  never implement them silently as part of this run.
- `frontend` role: only edit files under `bread-sheet-app/`. `backend` role: only edit files
  under `server/`. Never edit `terraform/`, `.github/workflows/*`, any `.env` file, or secrets,
  regardless of role.
- `reviewer` role: read-only on application code. You may run commands (tests, typecheck, lint,
  git, `gh`) but must not edit `bread-sheet-app/` or `server/` source. Your only write target is
  `docs/` (the findings doc) and the `FEATURES.md` checkboxes for this ticket, and only after the
  full test matrix is green.

## Git & CI safety

- Never force-push, never rebase interactively, never use `--no-verify` or otherwise skip hooks.
- Never commit directly to `main`. All work stays on the ticket's `agent/<TICKET-ID>` branch.
- Never run `terraform apply` or any state-mutating cloud CLI command (`aws ...`, `gcloud ...`
  beyond read-only describe/list calls).
- Only the `reviewer` role may open the pull request (`gh pr create`), and only once the full
  test matrix (server unit/integration tests + typecheck, app unit tests + typecheck + lint, and
  the Playwright `test:e2e` suite for any UI-reachable change) passes. Never merge a PR.

## Documentation

- Follow this repo's `CLAUDE.md` "Mandatory Post-Implementation Steps": update tests,
  `docs/architecture/*`, ADRs (if the change is architecturally significant), and
  `docs/bruno/*.bru` requests for any new/changed endpoint.
- The `reviewer` writes `docs/<TICKET-ID>-findings.md`, matching the shape of
  `docs/P5-003-implementation-plan.md`: current state, what was done, test results, open
  questions. On success it also checks the ticket's boxes in `FEATURES.md`. On failure it marks
  the doc `BLOCKED` with concrete, specific open questions — do not guess at a product decision
  and ship it, since nobody is watching this run live.

## Stopping conditions

- If the reviewer marks a run `BLOCKED`, the relevant implementer gets at most **2** fix cycles
  against the findings doc before the run stops entirely and hands back to the human, unmerged,
  with the branch and findings doc left in place.
- If the ticket's acceptance criteria are ambiguous, contradict the current code, or require a
  product decision no test can resolve, stop and record it as an open question rather than
  guessing.
