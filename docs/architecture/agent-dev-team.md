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
  `agent/<ticket-id>`, branched off `main`.
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

It's built on [Mastra](https://mastra.ai)'s `@mastra/core`, which turned out to ship most of
what a coding-agent toolbelt needs out of the box, so nothing here is hand-rolled beyond wiring:

- `src/agents/frontend-agent.ts` / `backend-agent.ts` use `createCodingAgent()` (from
  `@mastra/core/coding-agent`), each with its `basePath` rooted at the pillar's subdirectory
  inside the ticket's worktree (`bread-sheet-app/` / `server/`). That gives them a
  `LocalFilesystem` that's **physically contained** to that subtree by default — reading or
  writing outside it isn't just discouraged, it fails. The shell tool's working directory
  defaults to the same root, but shell commands *can* still `cd ..`; that boundary is
  instruction-enforced, same as Harness A.
- `src/agents/reviewer-agent.ts` builds its own `Workspace` rooted at the worktree root (it
  needs to run tests across both pillars and drive `git`/`gh`), but registers a
  `beforeToolCall` hook on every write/edit/mkdir/delete workspace tool that rejects any path
  outside `docs/` or `FEATURES.md`. This is a real enforcement mechanism, not just a prompt —
  see `isAllowedReviewerWritePath` in that file.
- `src/config.ts` resolves each role's model from `AGENT_MODEL_FRONTEND` /
  `_BACKEND` / `_REVIEWER`, falling back to `AGENT_MODEL`. It fails fast (no default model, no
  default provider) if unset, and rejects any provider prefix outside an explicit allow-list —
  same "fail fast, no inline env defaults" convention as `server/src/configs/config.ts`.
- `src/coordinator.ts` is a plain async function (not Mastra's `Workflow` DSL) so the
  bounded-retry/`BLOCKED`-handling control flow stays easy to read: create the worktree, decide
  which pillar(s) the ticket touches, run the implementer(s) in parallel, run the reviewer,
  retry up to twice on `BLOCKED`.

**Model/provider swapping is the point of this harness.** Mastra's model field is a
`"<provider>/<model-id>"` string routed through 90+ providers — moving the whole team from
Claude to GPT or DeepSeek is changing `AGENT_MODEL` (or the three per-role variables) and adding
the matching API key, no code change. **Today only Anthropic is exercised for real** — the
OpenAI/DeepSeek rows in `.env.example` are there so adding a key is the only step needed later.

## E2E testing (`bread-sheet-app/e2e/`)

The reviewer role — on either harness — runs Playwright specs against Expo web
(`npm run web`) as part of its test matrix; web covers everything except the native-only code
paths (camera, on-device OCR), which are covered by the native Maestro suite against a headless
Android emulator (`npm --prefix bread-sheet-app run test:maestro`, see § Native Android E2E
below). The native runner is self-provisioning, so installing an Android SDK/AVD is not a
per-run checklist item.

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
real auth, same prerequisite as manual testing. CI's new `e2e` job in
`.github/workflows/test.yml` needs `EXPO_PUBLIC_SUPABASE_URL` /
`EXPO_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` added as repository **variables** (Settings →
Secrets and variables → Actions → Variables — not Secrets: both are `EXPO_PUBLIC_*` values Expo
bakes into the client bundle, so they're already public) before it will pass — until then it
fails loudly rather than silently skipping.

**Fixed along the way:** `app.json`'s `web.output` was `"static"`, which makes `expo start
--web` server-render each route in a Node process before serving it. The Supabase client's
`AsyncStorage`-web fallback touches `window.localStorage` during that render pass, and Node has
no `window` — so `npm run web` crashed on every request, unrelated to anything in this feature.
Nothing in the repo depends on static prerendering (this app has no web production target), so
`web.output` was changed to `"single"` (a plain client-rendered SPA shell), which is also the
correct mode for a web target that only exists for dev/E2E use.

### Native Android E2E (TICKET-P9-003)

Built in [TICKET-P9-003] — this was the "Follow-up: Android emulator + Maestro (not built)"
gap. `bread-sheet-app/scripts/run-maestro-android.sh` is idempotent and self-provisioning: it
installs the Android command-line tools, the API 35 `google_apis;x86_64` system image and the
`bread-sheet-api-35` AVD (under `$ANDROID_HOME`, default `~/Android/Sdk`), a cached Temurin
JDK 17 when the host lacks one, and [Maestro](https://maestro.mobile.dev); then boots a
headless emulator, builds/installs the debug client with `expo run:android --variant debug`,
and runs the flows under `bread-sheet-app/e2e/maestro/`.

```sh
cd bread-sheet-app
npm run test:maestro
```

- **Prerequisites:** the runner fails fast (before any download or emulator boot) when
  `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` are unset or the
  app API is unreachable — start the local API (`cd server && npm run dev`) or set
  `EXPO_PUBLIC_API_URL` to a reachable URL. A host-local `EXPO_PUBLIC_API_URL`
  (`localhost`/`127.0.0.1`) is translated to the emulator's `10.0.2.2` host alias
  automatically.
- **Camera-input policy:** headless emulators cannot receive camera frames from Maestro, so the
  debug build exposes a "Use test barcode" fixture button on the Scan tab (only when
  `EXPO_PUBLIC_MAESTRO_BARCODE` is set; never in production) that drives the exact `expo-camera`
  barcode callback. The flow proves permission grant, native `CameraView` mounting, the scan
  callback, API lookup and product-route navigation — but not optical decoding, which is a
  documented limitation (see `bread-sheet-app/e2e/maestro/README.md` and
  `docs/architecture/frontend.md` § Native E2E).
- **Reviewer test matrix:** both harnesses (`.claude/agents/dev-reviewer.md` and
  `agent-team/src/agents/reviewer-agent.ts`) run the Maestro suite only for tickets whose diff
  touches camera/scan code — the shared contract is in `agent-team/src/prompts/guardrails.md`
  (§ Native E2E).
