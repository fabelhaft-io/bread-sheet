# Agentic Dev Workflow for the FEATURES.md Backlog

* Status: Accepted
* Date: 2026-08-10

## Context and Problem Statement

`FEATURES.md` carries 100+ open acceptance-criteria checkboxes across 8 phases. Working through
it by hand, ticket by ticket, doesn't scale with the time available. How should a team of coding
agents be set up to take a ticket from "picked" to "PR opened," reliably, without needing
step-by-step supervision — and without locking the whole effort to one AI vendor or one CLI
tool?

## Decision Drivers

* The team should run **unattended once triggered** — a human picks a ticket and starts it, but
  isn't expected to approve each step.
* Whatever ships something has to be **reviewable**: a findings doc plus a PR per ticket, not a
  direct commit to `main`.
* Testing has to go beyond unit tests — the team needs to exercise the app the way a user would
  (a real browser today; a real device/emulator eventually), or "reliability testing" is just a
  slogan.
* The harness (which CLI/SDK runs the agents) and the LLM behind it (Claude / GPT / DeepSeek)
  both need to be swappable as the project evolves, without rebuilding the workflow each time.

## Considered Options

* **Claude Code only** (`.claude/agents` + a skill) — fastest to build, but ties the whole
  effort to one CLI and, within it, only to Claude models.
* **Mastra-based standalone orchestrator only** — genuinely multi-provider from day one, but a
  much larger build (no first-party Claude Code integration, custom worktree/CLI plumbing) for
  zero benefit on the (currently) Claude-only common case.
* **Both, behind one shared contract** — a bit more to build and keep in sync, but neither
  harness is a special case of the other; adding a third harness later is "implement the
  contract again," not "refactor the first one."
* **E2E surface:** Playwright against Expo web vs. Maestro against an Android emulator. This
  machine has no Android SDK/emulator installed; web needs no extra install and covers
  everything except native-only paths (camera, on-device OCR).

## Decision Outcome

Chosen option: **"Both, behind one shared contract,"** with **Playwright/Expo-web** as the first
E2E surface and Maestro/Android documented as a follow-up.

The contract (ticket in, worktree isolation, three roles, findings-doc-and-PR out, the same
guardrails) is written once, in `agent-team/src/prompts/guardrails.md` and
`docs/architecture/agent-dev-team.md`, and both harnesses implement it rather than one wrapping
the other. Mastra was picked for the standalone harness specifically because its model field is
a provider-routed string covering 90+ providers, and because `@mastra/core/coding-agent` plus
its `Workspace`/`Sandbox` primitives already provide most of a coding-agent toolbelt
(file read/write/edit, shell execution) — building that from scratch on a lower-level SDK would
have been most of the effort for no real benefit.

Only Anthropic is wired to a real API key today (`agent-team/.env.example`); OpenAI/DeepSeek are
structurally supported (an allow-listed provider prefix plus one API key) but not exercised,
since there's no reason to pay for a provider nobody is using yet. That's a deliberate
asymmetry, not a gap — the seam exists so it's a config change later, not a rewrite.

### Positive Consequences

* Neither harness is privileged in the design — a third one (or dropping one) doesn't require
  touching the contract.
* The reviewer role's "don't silently patch application code" rule is enforced two different
  ways (instruction-only on Claude Code, a real `beforeToolCall` hook on Mastra) — trying both
  surfaced that the hook approach is strictly better, which will likely feed back into
  Harness A later.
* Building the Mastra harness surfaced a real, unrelated bug: `expo start --web` crashed on
  every request because of `app.json`'s `web.output: "static"` combined with the Supabase
  client's web storage fallback touching `window` during Node-side SSR. Fixed as part of this
  work (switched to `"single"`) since the E2E surface depended on it working at all.

### Negative Consequences

* Two harnesses to keep behaviorally identical — a change to the contract (e.g. the retry bound,
  or what counts as `BLOCKED`) has to be made in both places until/unless they're unified later.
* The Mastra harness is unverified end-to-end against a real model in this environment (no
  outbound network to any LLM provider from the sandbox this was built in) — its config
  fail-fast behavior and ticket parsing were verified directly, but a live run needs to happen
  in the user's own environment with a real `ANTHROPIC_API_KEY`.
* The `e2e` CI job needs `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`
  added as repository *variables* before it passes in CI — not done as part of this change
  (adding them is a deliberate, separate action for whoever owns the GitHub repo settings).
  Both are `EXPO_PUBLIC_*` values Expo bakes into the client bundle at build time, so they're
  already public — repository variables, not secrets, is the correct place for them.
