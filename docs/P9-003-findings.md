# P9-003 Findings — Android Emulator + Maestro E2E Coverage

**Status:** BLOCKED
**Date:** 2026-05-21 (re-review of branch tip `398db3c`)
**Branch:** `agent/P9-003` (target: `feat/agentic-dev-team`)
**Ticket:** [TICKET-P9-003] Android Emulator + Maestro E2E Coverage

---

## Current State

The two actionable blockers from the previous review are resolved and verified:

- **AC3 (reviewer test matrix in both harnesses) is implemented.** Commit `398db3c` wires a
  conditional `npm --prefix bread-sheet-app run test:maestro` step into
  `.claude/agents/dev-reviewer.md` **and** `agent-team/src/agents/reviewer-agent.ts`, and the
  shared contract in `agent-team/src/prompts/guardrails.md` now has a "Native E2E (Android +
  Maestro)" section describing when to run it (camera/scan-touching diffs), the
  self-provisioning behavior, and the fail-fast credential/API gate. All three files verified
  at branch tip.
- **`docs/architecture/agent-dev-team.md` is no longer stale.** The "not built" follow-up
  section is replaced by "Native Android E2E (TICKET-P9-003)" and the E2E intro now points at
  the Maestro suite. `docs/architecture/frontend.md` § Native E2E and `README.md` are
  consistent with it.

However, this review found a **new code-level defect** in the runner that would prevent the
Maestro flow from ever executing against a working debug build: `run-maestro-android.sh`
invokes `npx expo run:android --variant debug --no-bundler ...` and nothing else keeps a
Metro/bundle server alive, so the freshly installed debug app cannot load its JS bundle when
`maestro test` starts. Detail in Open Question 1 below. A full successful native run also
remains undemonstrated (Supabase E2E credentials are human-managed and absent here). **BLOCKED.**

## Coordinator Scope Check

Flagged files: `.claude/agents/dev-reviewer.md`, `README.md`,
`agent-team/src/agents/reviewer-agent.ts`, `agent-team/src/prompts/guardrails.md`,
`docs/P9-003-findings.md`, `docs/architecture/agent-dev-team.md`,
`docs/architecture/frontend.md`. All are in scope for this ticket: the first three/four are
the ticket's AC3 deliverable (wire the Maestro step into both reviewer harnesses + shared
contract), and the docs are the mandatory post-implementation documentation (`CLAUDE.md`)
plus this required reviewer artifact. The implementer's frontend-pillar boundary was
`bread-sheet-app/`; the harness/doc writes are the ticket's explicit ask. Not a blocker.

## What Was Implemented (verified at branch tip `398db3c`)

- `bread-sheet-app/scripts/run-maestro-android.sh` — self-provisioning, idempotent runner:
  Android cmdline-tools / API 35 `google_apis;x86_64` system image / `bread-sheet-api-35` AVD
  under `$ANDROID_HOME` (default `~/Android/Sdk`), cached Temurin JDK 17 when the host lacks
  one, Maestro, headless emulator boot, `expo run:android --variant debug`, then
  `maestro test e2e/maestro/barcode-scan.yaml`.
  - Fail-fast before any download: missing `EXPO_PUBLIC_SUPABASE_URL` /
    `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` → clear error, exit 1; unreachable API →
    clear error naming the remediation, exit 1 (verified live this review: exit 1 at the
    credentials gate with the documented message). `localhost`/`127.0.0.1`
    `EXPO_PUBLIC_API_URL` is translated to the emulator alias `10.0.2.2` with a reproducible
    default `http://10.0.2.2:3000`.
- `bread-sheet-app/e2e/maestro/barcode-scan.yaml` — guest sign-in → Scan tab → camera
  permission → wait for native `CameraView` hint → tap `Use test barcode` → assert Product
  route. All selectors verified against actual app strings this review ("Continue as Guest" in
  `app/(auth)/login.tsx`; "Scan" tab title in `app/(tabs)/_layout.tsx`; "Allow Camera" and
  "Align barcode within the frame" in `app/(tabs)/scan.tsx`; "Use test barcode" fixture
  button; "Product" stack header in `app/(app)/_layout.tsx`).
- `bread-sheet-app/app/(tabs)/scan.tsx` — debug-only `Use test barcode` fixture button
  rendered only when `__DEV__` and `EXPO_PUBLIC_MAESTRO_BARCODE` are set; it invokes the exact
  `handleBarcodeScanned` callback `expo-camera` drives. Never in a production build.
- `bread-sheet-app/app/(tabs)/scan-screen.test.tsx` — 3 new tests pinning the fixture
  contract (hidden when env unset; valid code routes to `/(app)/product/<code>`; invalid code
  opens the pre-filled manual sheet). 10/10 in-suite, PASS this review.
- `bread-sheet-app/e2e/maestro/README.md` + `docs/architecture/frontend.md` § Native E2E —
  invocation, prerequisites, and the explicit, documented product decision that the fixture
  proves permission + `CameraView` + callback + API lookup + navigation but not optical
  decoding (Maestro cannot inject camera frames into a headless AVD).
- `bread-sheet-app/package.json` — `test:maestro` script; Playwright config/e2e specs now
  skip gracefully without Supabase credentials instead of crashing.
- `.claude/agents/dev-reviewer.md`, `agent-team/src/agents/reviewer-agent.ts`,
  `agent-team/src/prompts/guardrails.md` — AC3 conditional Maestro test-matrix step + shared
  contract (this review's addition, commit `398db3c`).
- `README.md`, `docs/architecture/agent-dev-team.md` — native E2E documentation.

## Test Results (this review)

| Check | Result | Notes |
|---|---|---|
| `npm --prefix bread-sheet-app run typecheck` | PASS | Exit 0. |
| `npm --prefix bread-sheet-app run lint` | PASS | Exit 0; one pre-existing unused-variable warning in `app/(app)/review-edit/[editId].tsx`. |
| `npm --prefix bread-sheet-app test -- --runInBand` | PASS | 28 suites / 242 tests, exit 0; incl. `scan-screen` suite 10/10 with the 3 new fixture tests. |
| `npm --prefix bread-sheet-app run test:e2e` | PASS (2 skipped) | Exit 0; both Playwright specs skip because local Supabase E2E credentials are absent — documented graceful-skip behavior, not a web assertion. |
| `npm --prefix bread-sheet-app run test:maestro` | FAIL (fail-fast, as designed) | Exit 1 at the credentials gate with the documented error. No emulator boot or flow run possible in this environment (no Supabase creds; no `cmdline-tools` in `~/Android/Sdk`; no host JDK — the script would provision these, but the gate stops it first). |
| Expo CLI `--no-bundler` behavior | CODE DEFECT FOUND | `expo run:android --no-bundler` starts Metro headless then calls `manager.stopAsync()` right after launching the app; the script never starts/keeps a bundle server — see Open Question 1. |
| Server typecheck/tests | NOT RUN | No `server/` files touched by the branch (backend pillar not invoked). |

## Acceptance Criteria Review

1. **Android emulator runs locally (or in CI) without manual per-run setup — NOT VERIFIED
   end-to-end, and the runner has a bundler defect that would break the run.** The
   provisioning logic is sound and the fail-fast gates behave correctly (verified). But the
   script's `--no-bundler` invocation leaves the debug app with no Metro to load its JS
   bundle from (Open Question 1), and no full provisioning → emulator boot → debug-build
   install → flow run has been demonstrated (environment lacks Supabase credentials, which
   are human-managed per P9-002; fabrication is forbidden by the shared contract).

2. **At least one Maestro flow exercises barcode scanning end-to-end against a debug build —
   NOT VERIFIED end-to-end, plus the bundler defect.** The YAML flow is well-formed, its
   selectors match the app's actual UI text (verified), and the fixture contract is
   unit-tested; the fixture-vs-optical-decode product decision is documented and accepted.
   But even with credentials, the debug app cannot load its JS bundle under the current
   runner (`--no-bundler` + no Metro), so the flow would fail at the first step — this must
   be fixed and then evidenced with one green run.

3. **Reviewer test matrix in both harnesses runs Maestro for camera/scan tickets — MET.** Both
   `.claude/agents/dev-reviewer.md` and `agent-team/src/agents/reviewer-agent.ts` contain the
   conditional `npm --prefix bread-sheet-app run test:maestro` step, and the shared contract
   in `agent-team/src/prompts/guardrails.md` documents the trigger, the self-provisioning
   runner, and the fail-fast environment-gap handling. Verified at branch tip.

## Required Fixes / Open Questions

1. **Fix the bundler lifecycle in `run-maestro-android.sh` (code defect, actionable).** The
   script runs `npx expo run:android --variant debug --no-bundler --device "$AVD_NAME"` and
   never starts Metro anywhere else. In Expo SDK 57's CLI (verified in
   `bread-sheet-app/node_modules/expo/node_modules/@expo/cli/build/src/run/android/runAndroidAsync.js`,
   `run/resolveBundlerProps.js`, `run/startBundler.js`,
   `start/server/DevServerManager.js`), `--no-bundler` sets `shouldStartBundler=false`, which
   makes `runAndroidAsync` start Metro headless (`startBundlerAsync` with `headless: true`)
   and then call `manager.stopAsync()` immediately after `openCustomRuntimeAsync` launches
   the app on the emulator. Debug builds do not embed the JS bundle (eager bundling is
   release-only, `isProduction` branch), so the freshly installed app — launched with
   `clearState` — cannot fetch its bundle and will show the RN "Unable to load script" screen
   before Maestro's first `tapOn`. **Fix:** keep a bundle server alive for the whole run —
   e.g. start `npx expo start` (background) before `expo run:android` and keep it running
   until `maestro test` completes, confirming the CLI reuses that server instead of stopping
   it (and that Maestro's `launchApp` hits the dev build). Then demonstrate one green run.

2. **Demonstrate one successful `npm --prefix bread-sheet-app run test:maestro` run** in an
   environment with configured Supabase E2E credentials and a running local API
   (`cd server && npm run dev`), reaching the final Product-route assertion — this closes the
   AC1/AC2 evidence gap. In this environment the runner exits 1 at the credentials gate by
   design (verified); that is an environment prerequisite gap per the shared contract, not a
   code failure, and credentials must be supplied by a human, never fabricated.

3. **Re-run the Playwright web specs in a configured-credentials environment** so they
   execute rather than skip (they skip gracefully now, which is an improvement, but a green
   run is still the real evidence). Not a blocker on its own.

Resolved since the last review (verified, no further action): AC3 harness wiring in both
harnesses + shared contract (was open question #1); `docs/architecture/agent-dev-team.md`
stale "not built" section replaced (was open question #3).

## Review Summary

AC3 is now fully implemented and verified, and the documentation is consistent. But the
runner has a code-level defect — `expo run:android --no-bundler` tears down Metro before the
debug app can load its bundle, and nothing else in the script keeps a bundle server alive —
so the Maestro flow cannot run end-to-end against the debug build as written. That is
actionable by the implementer (Open Question 1), independent of the credential environment
gap (Open Question 2). **BLOCKED.** No PR opened.

## Reviewer Sign-off

**Reviewer:** Agentic dev-team reviewer
**Decision:** BLOCKED

---

## Appendix: Files Reviewed

- `bread-sheet-app/scripts/run-maestro-android.sh` (incl. `--no-bundler` bundler-lifecycle defect)
- `bread-sheet-app/e2e/maestro/barcode-scan.yaml` (selectors verified against app UI text)
- `bread-sheet-app/e2e/maestro/README.md`
- `bread-sheet-app/app/(tabs)/scan.tsx`, `app/(tabs)/scan-screen.test.tsx`
- `bread-sheet-app/package.json`, `bread-sheet-app/playwright.config.ts`
- `bread-sheet-app/e2e/auth.spec.ts`, `bread-sheet-app/e2e/scan-tab.spec.ts`
- `.claude/agents/dev-reviewer.md` (AC3 — met), `agent-team/src/agents/reviewer-agent.ts`
  (AC3 — met), `agent-team/src/prompts/guardrails.md` (shared contract — met)
- `README.md`, `docs/architecture/frontend.md`, `docs/architecture/agent-dev-team.md`
- Expo CLI internals: `@expo/cli/build/src/run/android/runAndroidAsync.js`,
  `run/resolveBundlerProps.js`, `run/startBundler.js`,
  `start/server/DevServerManager.js`, `start/platforms/android/AndroidPlatformManager.js`
- `FEATURES.md` (P9-003 checkboxes remain unchecked)

**BLOCKED**
