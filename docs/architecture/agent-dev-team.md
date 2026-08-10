# Agentic Dev Team

BreadSheet's backlog (`FEATURES.md`) is worked through, ticket by ticket, by a small team of
coding agents rather than by hand for every item. A human picks a ticket and triggers a run;
from there the team implements, tests, documents, and opens a PR (or documents a blocker)
without needing step-by-step approval. See `../architecture-decision-records/0004-agentic-dev-workflow.md`
for why it's built this way.

## The shared contract

Both harnesses below implement the exact same contract — this is what makes swapping the
harness (or the LLM behind it) a config change, not a rewrite:

- **Input:** a ticket ID that exists as a `### [TICKET-...]` heading in `FEATURES.md`.
- **Isolation:** a dedicated git worktree at `../bread-sheet-agent-<ticket-id>` on branch
  `agent/<ticket-id>`, branched off `main` (Harness B: override with `BASE_BRANCH` in
  `agent-team/.env` for a dry run against a branch that hasn't merged to `main` yet — the
  worktree needs `agent-team/` and the ticket itself to actually exist on whatever it's
  branched from).
- **Roles:**
  - `frontend` — implements, owns `bread-sheet-app/` only.
  - `backend` — implements, owns `server/` only.
  - `reviewer` — the merge gate. Read/test-only on application code; its only write targets
    are `docs/` and the ticket's checkboxes in `FEATURES.md`.
- **Output on success:** the ticket's boxes checked in `FEATURES.md`, a
  `docs/<TICKET-ID>-findings.md` findings doc (see shape below), a PR opened against `main`.
- **Output on failure:** no PR. The findings doc is marked `BLOCKED` with concrete open
  questions, and the branch is left in place for a human to pick up.
- **Guardrails:** no `terraform apply`/mutating cloud CLI calls; no editing
  `.github/workflows/*`, secrets, or `.env` files; no direct commits to `main`, no force-push,
  no `--no-verify`; only the reviewer may open the PR (never merge it); ticket scope stays as
  written — extra ideas go into the findings doc as follow-ups, not into the diff; a `BLOCKED`
  review gets at most **2** fix cycles with the implicated implementer before the run stops and
  hands back to the human.
- **Test matrix the reviewer must run before passing a ticket:** `server` `npm test` +
  `typecheck`; `bread-sheet-app` `npm test` + `typecheck` + `lint`; `bread-sheet-app`
  `npm run test:e2e` for anything reachable through the UI.

The full guardrail wording is kept in one place — `agent-team/src/prompts/guardrails.md` — and
both harnesses reference/embed it, so they can't silently drift apart on what's allowed.

Findings doc shape (mirrors `docs/P5-003-implementation-plan.md`): current state, what was
implemented, test results (pass/fail summary, not full logs), open questions.

### Typed handoff (Harness B)

The findings doc above is for humans. The *coordinator*-facing handoff is a schema-validated
object, not prose the coordinator has to re-parse. `agent-team/src/lib/handoff.ts` defines two
Zod schemas:

- `implementerHandoffSchema` — `status` (`DONE`/`BLOCKED`), `filesChanged`, `testResults`
  (`typecheck`/`lint`/`unitTests`, each `pass`/`fail`/`not_run`), a one-paragraph `summary`
  (used as the coordinator's commit message), and `openQuestions`.
- `reviewerHandoffSchema` — `status` (`PASS`/`BLOCKED`), `findingsDocPath`, `prTitle`/`prBody`
  (the coordinator opens the PR itself — see "Coordinator-owned git" below), a six-field
  `testMatrix`, and `openQuestions` (required, concrete, non-empty when `BLOCKED`).

Each implementer/reviewer call is `agent.stream(prompt, { structuredOutput: { schema } })`. The
coordinator drains `output.fullStream` (`src/lib/progress.ts`'s `logAgentProgress`, one terse
`[frontend]`/`[backend]`/`[reviewer]`-prefixed line per tool call/result) and then awaits
`output.object` for the schema-validated result.

`findOutOfPillarFiles` (same file) is a second check: after the implementer(s) finish, the
coordinator diffs the worktree for real (`git diff`/`git status`, not the model's self-reported
`filesChanged`) against the pillar(s) actually invoked, and surfaces anything outside all of
them to the reviewer as a `COORDINATOR SCOPE CHECK` line — a flag to confirm, not an
auto-reject, since a legitimate ticket occasionally needs both pillars. The actual enforcement
that stops an out-of-scope change from ever being committed is "Coordinator-owned git" below.

Harness A (Claude Code) has no equivalent schema enforcement — a subagent's report back to the
coordinator skill is still prose, checked by instruction only. Intentional asymmetry: Claude
Code's Agent tool doesn't expose a structured-output contract the same way.

### OS-level shell sandboxing (Harness B)

`LocalFilesystem`'s `basePath` containment only restricts file *tools*
(`read_file`/`write_file`/`edit_file`/...) — it does not restrict `execute_command`. A shell
command can `cd ..` and write anywhere. `agent-team/src/lib/sandbox.ts`'s `hardenedSandbox()`
closes this on Linux via bubblewrap (`isolation: 'bwrap'`): writes outside the allowed paths
never reach the real filesystem, even though the shell command itself reports success (bwrap
gives the process its own ephemeral view).

Two fixes on top of `@mastra/core`'s own bwrap builder, since its default omits both:
- No `/dev` is bound by default, which breaks anything touching `/dev/null` (most tools,
  git included) — fixed via `--dev-bind /dev /dev`.
- `allowSystemBinaries` only binds `process.execPath`'s own `bin/` directory. Under a version
  manager (nvm here), `npm` is a symlink into a sibling `lib/node_modules/npm/`, invisible
  unless the whole version directory is bound.

Passing `bwrapArgs` to `LocalSandbox` **replaces** Mastra's default argument construction
rather than extending it, so `hardenedSandbox()` duplicates that default rather than layering
on top — a coupling risk if `@mastra/core`'s builder changes later. Non-Linux (or bwrap
unavailable) falls back to no isolation with a one-time warning rather than silently claiming
an unverified guarantee — seatbelt (macOS) hasn't been tested against this repo.

### Coordinator-owned git (Harness B)

OS-level sandboxing alone doesn't fully close the scope gap: a single shell invocation that
writes a file and then runs `git add && git commit` in the same sandboxed session can still get
that ephemeral content into the real git object database, since the object store has to stay
writable for commits to work at all.

So agents have no git write access, period — `readOnlyPaths` in each agent's sandbox covers
only `status`/`diff`/`log`; `add`/`commit`/`push` fail with "Read-only file system". The
coordinator (`coordinator.ts`, unsandboxed, trusted Node code) is the only thing that ever runs
`git add`/`commit`/`push`/`gh pr create`, working from real, post-agent-turn disk state — an
out-of-scope write that never persisted has nothing for the coordinator to accidentally stage.
After each implementer turn it commits only `filterCommittableImplementerFiles`'s result
(pillar prefixes plus each pillar's documented doc exceptions — `FRONTEND_EXTRA_PATHS`/
`BACKEND_EXTRA_PATHS`/`BACKEND_EXTRA_PREFIXES` in `handoff.ts`, the same source of truth each
agent's `LocalFilesystem.allowedPaths` reads from), using the implementer's `summary` as the
message. After the reviewer, it commits `filterCommittableReviewerFiles`'s result (`docs/` +
`FEATURES.md`). On `PASS` it pushes the branch and runs `gh pr create` itself using the
reviewer's `prTitle`/`prBody`, returning the real URL `gh` prints — not a model-reported one.

## Harness A — Claude Code

`.claude/agents/dev-frontend.md`, `dev-backend.md`, `dev-reviewer.md` implement the three roles
using Claude Code's native `Read`/`Edit`/`Write`/`Bash` tools; the reviewer's tool scoping to
`docs/`/`FEATURES.md` is instruction-enforced (Claude Code has no per-path tool sandbox), and
the implementers get no `Agent` tool so they can't sub-spawn.

`.claude/skills/dev-team/SKILL.md` is the coordinator, run inline in whichever Claude Code
session invokes it. Trigger with:

```
/dev-team <TICKET-ID>
```

It creates the worktree, spawns the relevant implementer agent(s), spawns the reviewer, applies
the bounded-retry rule, and reports back the PR link or the blocker.

Model choice for this harness is one line per agent's frontmatter (`model:` in each
`.claude/agents/dev-*.md`) — it only swaps within the Claude model family (Opus/Sonnet/
Haiku/Fable). Cross-provider swapping (GPT, DeepSeek) is Harness B's job.

## Harness B — standalone Mastra orchestrator

`agent-team/` is a separate Node/TS project, invoked outside any Claude Code session:

```sh
cd agent-team
cp .env.example .env   # fill in AGENT_MODEL + the matching provider API key
npm install
npm run dev-team -- <TICKET-ID>
```

Built on [Mastra](https://mastra.ai)'s `@mastra/core`, which ships most of a coding-agent
toolbelt out of the box:

- `src/agents/frontend-agent.ts` / `backend-agent.ts` use `createCodingAgent()` with `basePath`
  rooted at the pillar's subdirectory in the worktree (`bread-sheet-app/` / `server/`) — a
  `LocalFilesystem` physically contained to that subtree, plus a few least-privilege exceptions
  (`CLAUDE.md` read-only, each pillar's own architecture doc + relevant extras read-write,
  driven from `handoff.ts`'s shared path constants). Sandboxed shell, no git write access (see
  the two sections above).
- `src/agents/reviewer-agent.ts` builds its own `Workspace` rooted at the worktree root (needs
  to run tests across both pillars) and registers a `beforeToolCall` hook rejecting any
  write/edit/mkdir/delete outside `docs/`/`FEATURES.md` (`isAllowedReviewerWritePath`). Same
  sandboxed shell, same no-git-write-access — it no longer opens the PR itself either.
- `src/config.ts` resolves each role's model from `AGENT_MODEL_FRONTEND`/`_BACKEND`/`_REVIEWER`,
  falling back to `AGENT_MODEL`. Fails fast (no default model, no default provider) if unset,
  rejects any provider prefix outside an explicit allow-list — same "fail fast, no inline env
  defaults" convention as `server/src/configs/config.ts`.
- `src/coordinator.ts`: plain async function (not Mastra's `Workflow` DSL). Creates the
  worktree, decides pillars, runs implementer(s) in parallel, commits their real changes, runs
  the reviewer, commits its docs/FEATURES.md changes, pushes + opens the PR on `PASS`, retries
  up to twice on `BLOCKED`. Every coordinator-side action logs with a `[coordinator]` prefix,
  distinct from the agents' own `[frontend]`/`[backend]`/`[reviewer]` lines.

**Model/provider swapping is the point of this harness** — verified for real, not just
designed: `P9-003` has reached a genuine `PASS` on DeepSeek, and separately confirmed working
end-to-end on Anthropic. Moving the whole team to a different provider is changing
`AGENT_MODEL` (or the three per-role variables) and adding the matching API key, no code
change — but mind the exact model-ID string each provider expects (e.g. DeepSeek wants
lowercase hyphenated names like `deepseek-v4-flash`, not `DeepSeek-V4-Flash`); `config.ts`'s
fail-fast only catches a bad provider *prefix*, a bad model name within a valid provider
surfaces as a live API error instead.

## E2E testing (`bread-sheet-app/e2e/`)

The reviewer role — on either harness — runs Playwright specs against Expo web
(`npm run web`) as part of its test matrix. This machine has no Android SDK/emulator, so native
device testing (Maestro) isn't built yet; web was chosen as the first surface because it needs
no extra install and covers everything except native-only code paths (camera, on-device OCR).

```sh
cd bread-sheet-app
npx playwright install chromium   # one-time
npm run test:e2e
```

Seed specs (extend one per ticket that adds a new user-reachable flow, rather than writing a
new file for every small addition):

- `e2e/auth.spec.ts` — guest sign-in lands on the Home tab.
- `e2e/scan-tab.spec.ts` — the Scan tab degrades to a permission prompt with no camera
  available, instead of crashing — the same camera-free principle `CLAUDE.md` calls out
  elsewhere in the frontend.

Both specs need a working `bread-sheet-app/.env` (a reachable Supabase project) — they exercise
real auth, same prerequisite as manual testing. CI's `e2e` job in `.github/workflows/test.yml`
needs `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` added as
repository **variables** (not Secrets — both are `EXPO_PUBLIC_*` values Expo bakes into the
client bundle, so they're already public) before it will pass.

`app.json`'s `web.output` is `"single"`, not Expo's default `"static"` — static mode
server-renders each route in Node before serving it, and the Supabase client's
`AsyncStorage`-web fallback touches `window.localStorage` during that render pass, which
crashes with no `window` in Node. Nothing in the repo depends on static prerendering, so
`"single"` (a plain client-rendered SPA shell) is also the correct mode for a web target that
only exists for dev/E2E use.

### Follow-up: Android emulator + Maestro (not built)

Documented here so it's a known next step, not a silent gap. Needs, in order:

1. Android SDK + an AVD on the dev machine (or a CI-hosted emulator action).
2. [Maestro](https://maestro.mobile.dev) installed — its declarative YAML flows are a good fit
   for agent-authored specs (screenshot assertions, no native build step beyond a debug APK).
3. A `reviewer` test-matrix step added on both harnesses once (1) and (2) exist, covering the
   camera/barcode-scan paths Playwright/web structurally can't reach.
