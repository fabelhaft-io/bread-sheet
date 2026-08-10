# P9-003 Findings — Android Emulator + Maestro E2E Coverage

**Status:** BLOCKED
**Date:** 2026-05-21 (re-review of branch tip `b942d2a`)
**Branch:** `agent/P9-003` (target: `feat/agentic-dev-team`)
**Ticket:** [TICKET-P9-003] Android Emulator + Maestro E2E Coverage

---

## Current State

Since the previous BLOCKED review, the implementer hardened the native runner
(`16e4777`, `b942d2a`): the Java-version extraction bug is fixed, the script now fails
fast on missing Supabase credentials and an unreachable API, and the debug barcode
fixture's contract is pinned by unit tests. That work is real and verified. However, the
ticket's third acceptance criterion — wiring the Maestro step into **both** reviewer
harnesses — is still not implemented at all, and `docs/architecture/agent-dev-team.md`
still describes Android/Maestro as "not built", directly contradicting the new docs. A
full successful native run has also not been demonstrated in this environment (requires
Supabase E2E credentials + a running API + a full Android build). **BLOCKED.**

## Coordinator Scope Check

The coordinator flagged `README.md`, `docs/P9-003-findings.md`, and
`docs/architecture/frontend.md` as outside the frontend pillar's file scope. They are all
documentation for the implemented frontend native-E2E work and are in scope for this
docs-heavy ticket: `docs/P9-003-findings.md` is the required reviewer artifact,
`README.md` documents the new `npm run test:maestro` command, and
`docs/architecture/frontend.md` documents the native E2E strategy. The implementer wrote
outside `bread-sheet-app/` to produce them, which is consistent with `CLAUDE.md`'s
"Mandatory Post-Implementation Steps" (update `docs/architecture/*`); not a blocker.

## What Was Implemented (verified at branch tip)

- `bread-sheet-app/scripts/run-maestro-android.sh` — self-provisioning, idempotent runner:
  Android cmdline-tools / API 35 `google_apis;x86_64` system image / `bread-sheet-api-35`
  AVD under `$ANDROID_HOME`, cached Temurin JDK 17 when the host lacks one, Maestro,
  headless emulator boot, `expo run:android --variant debug`, then `maestro test`.
  - Java-version extraction fixed (`java_major_version` handles `17.0.x` and legacy
    `1.8.x`; the old `sed` producing literal `\1` is gone).
  - Fail-fast before any download: missing `EXPO_PUBLIC_SUPABASE_URL` /
    `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` → clear error, exit 1; unreachable
    API → clear error naming the remediation, exit 1. `localhost`/`127.0.0.1`
    `EXPO_PUBLIC_API_URL` is translated to the emulator alias `10.0.2.2` with a
    reproducible default `http://10.0.2.2:3000`.
- `bread-sheet-app/e2e/maestro/barcode-scan.yaml` — guest sign-in → Scan tab → camera
  permission → wait for native `CameraView` hint → tap `Use test barcode` → assert
  Product route.
- `bread-sheet-app/app/(tabs)/scan.tsx` — debug-only `Use test barcode` fixture button,
  rendered only when `__DEV__` and `EXPO_PUBLIC_MAESTRO_BARCODE` are set; it invokes the
  exact `handleBarcodeScanned` callback `expo-camera` drives. Never in a production build.
- `bread-sheet-app/app/(tabs)/scan-screen.test.tsx` — 3 new tests pinning the fixture
  contract (hidden when env unset; valid code routes to `/(app)/product/<code>`; invalid
  code opens the pre-filled manual sheet).
- `bread-sheet-app/e2e/maestro/README.md` + `docs/architecture/frontend.md` § Native E2E —
  invocation, prerequisites, and an explicit, documented product decision that the
  fixture proves permission + `CameraView` + callback + API lookup + navigation but not
  optical decoding (Maestro cannot inject camera frames into a headless AVD).
- `bread-sheet-app/package.json` — `test:maestro` script; Playwright config/e2e specs now
  skip gracefully without Supabase credentials instead of crashing.
- `README.md` — native E2E section.

## Test Results (this review)

| Check | Result | Notes |
|---|---|---|
| `npm --prefix bread-sheet-app run typecheck` | PASS | Exit 0. |
| `npm --prefix bread-sheet-app run lint` | PASS | Exit 0; one pre-existing unused-variable warning in `app/(app)/review-edit/[editId].tsx`. |
| `npm --prefix bread-sheet-app test -- --runInBand` | PASS | 28 suites / 242 tests, exit 0; incl. the 3 new `scan-screen` fixture tests (10/10 in that suite). |
| `npm --prefix bread-sheet-app run test:e2e` | PASS (2 skipped) | Exit 0; both Playwright specs skip because local Supabase E2E credentials are absent — documented graceful-skip behavior, not a web assertion. |
| `npm --prefix bread-sheet-app run test:maestro` | FAIL (fail-fast, as designed) | Missing Supabase creds → clear error, exit 1. With placeholder creds → API-not-reachable error, exit 1. No emulator boot or Maestro flow run demonstrated (no credentials/API in this environment). |
| Java version parsing | PASS | Verified `sed`/regex against `openjdk 17.0.x`, legacy `1.8.x`, `21.0.x` samples. |
| Server typecheck/tests | NOT RUN | No `server/` files touched by the branch. |
| Minor observation | — | Direct `bash scripts/run-maestro-android.sh` with `HOME` unset crashes on `set -u` (`HOME: unbound variable`); HOME is always set on normal dev machines/CI runners, so this is an environment artifact, not a blocker. |

## Acceptance Criteria Review

1. **Android emulator runs locally (or in CI) without manual per-run setup — NOT VERIFIED
   end-to-end.** The runner is now genuinely self-provisioning and its fail-fast
   prerequisites behave correctly (both verified). But no successful provisioning →
   emulator boot → debug-build install → flow run was demonstrated in this review: the
   run stops at the credential/API gate because `EXPO_PUBLIC_SUPABASE_*` are
   human-managed secrets (see P9-002) and no API was running. An environment with the
   documented secrets + `cd server && npm run dev` is needed to close this.

2. **At least one Maestro flow exercises barcode scanning end-to-end against a debug
   build — NOT VERIFIED end-to-end.** The YAML flow + debug fixture are well-formed and
   unit-tested, and the same-callback limitation is now an explicit, documented product
   decision (`e2e/maestro/README.md`, `docs/architecture/frontend.md`). What is still
   missing is evidence of one successful `test:maestro` run against the installed debug
   build (credentials + API + emulator). The fixture-vs-real-frame question is resolved
   by that documented decision, but the run itself has not been shown.

3. **Reviewer test matrix in both harnesses runs Maestro for camera/scan tickets — NOT
   MET.** Neither `.claude/agents/dev-reviewer.md` nor
   `agent-team/src/agents/reviewer-agent.ts` contains a conditional
   `npm --prefix bread-sheet-app run test:maestro` step, and neither file was touched by
   this branch (`git log feat/agentic-dev-team..HEAD -- <both files>` is empty; a repo
   grep for `maestro` in `.claude/` and `agent-team/src/` finds nothing). This was open
   question #1 in the previous BLOCKED doc and remains completely unaddressed.

## Required Fixes / Open Questions

1. **Add the conditional Maestro test-matrix step to both reviewer harnesses** —
   `.claude/agents/dev-reviewer.md` and `agent-team/src/agents/reviewer-agent.ts` (and
   keep the shared contract in `agent-team/src/prompts/guardrails.md` in sync). The step
   should run `npm --prefix bread-sheet-app run test:maestro` only for tickets whose diff
   touches camera/scan code (e.g. `app/(tabs)/scan.tsx`, `e2e/maestro/`), and should
   preserve the existing guardrails and this run's base branch `feat/agentic-dev-team`.
   This is the ticket's third acceptance criterion, verbatim.

2. **Demonstrate one successful `npm --prefix bread-sheet-app run test:maestro` run** in
   an environment with configured Supabase E2E credentials and a running local API
   (`cd server && npm run dev`), reaching the final Product-route assertion. Record the
   result here so AC1/AC2 are evidenced, not just plausibly implemented.

3. **Update `docs/architecture/agent-dev-team.md`** — its E2E section still says "This
   machine has no Android SDK/emulator, so native device testing (Maestro) isn't built
   yet" and its "Follow-up: Android emulator + Maestro (not built)" section is unchanged,
   contradicting `docs/architecture/frontend.md` / `README.md` and the ticket premise.
   Replace it with the chosen provisioning, invocation, API prerequisite, and
   camera-input policy (or point at the new frontend.md section).

4. Re-run the Playwright web specs in a configured-credentials environment so they
   execute rather than skip (they skip gracefully now, which is an improvement, but a
   green run is still the real evidence).

## Review Summary

The native runner is now materially better — fail-fast prerequisites verified, Java
provisioning fixed, fixture contract pinned by unit tests, and the headless-camera
limitation honestly documented. But the ticket's third acceptance criterion (reviewer
test matrix in both harnesses) is not implemented, the referenced architecture doc is
stale, and no end-to-end native run has been demonstrated. These were the top open
questions of the previous review; the first two remain open. **BLOCKED.** No PR opened.

## Reviewer Sign-off

**Reviewer:** Agentic dev-team reviewer
**Decision:** BLOCKED

---

## Appendix: Files Reviewed

- `bread-sheet-app/scripts/run-maestro-android.sh`
- `bread-sheet-app/e2e/maestro/barcode-scan.yaml`
- `bread-sheet-app/e2e/maestro/README.md`
- `bread-sheet-app/app/(tabs)/scan.tsx`
- `bread-sheet-app/app/(tabs)/scan-screen.test.tsx`
- `bread-sheet-app/package.json`
- `bread-sheet-app/playwright.config.ts`
- `bread-sheet-app/e2e/auth.spec.ts`, `bread-sheet-app/e2e/scan-tab.spec.ts`
- `README.md`, `docs/architecture/frontend.md`
- `docs/architecture/agent-dev-team.md` (stale follow-up section)
- `.claude/agents/dev-reviewer.md` (unchanged — AC3 gap)
- `agent-team/src/agents/reviewer-agent.ts` (unchanged — AC3 gap)
- `agent-team/src/prompts/guardrails.md` (unchanged — AC3 gap)
- `FEATURES.md` (P9-003 checkboxes remain unchecked)

**BLOCKED**
