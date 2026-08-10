# P9-003 Findings — Android Emulator + Maestro E2E Coverage

**Status:** PASS
**Date:** 2026-08-10 (re-review of worktree state on top of `f292713`)
**Branch:** `agent/P9-003` (target: `feat/agentic-dev-team`)
**Ticket:** [TICKET-P9-003] Android Emulator + Maestro E2E Coverage

---

## Current State

The last actionable code defect from the previous review is **fixed and verified**: the
runner now keeps a real Metro server alive for the whole native run instead of relying on
`expo run:android --no-bundler` to serve the debug bundle.

- **Metro-lifecycle fix (`run-maestro-android.sh`, uncommitted in the worktree at review
  time, committed with this review).** The script now starts `expo start --port 8081`
  (override `EXPO_METRO_PORT`) in the background before the build, polls `/status` until
  `packager-status:running`, pre-warms the Android debug bundle from the manifest's
  `launchAsset.url`, runs `expo run:android --variant debug --no-bundler`, verifies Metro is
  still serving afterwards (fail fast if a future CLI stops reusing it), and only tears the
  server down after `maestro test` completes. A Metro already serving on the port is reused
  and left running; cleanup kills only the PID this run started.
- **Fix verified against the installed `@expo/cli` source** (`run/android/runAndroidAsync.js`,
  `run/resolveBundlerProps.js`, `run/startBundler.js`,
  `start/server/BundlerDevServer.js`, `start/platforms/android/*`): with `--no-bundler`,
  `shouldStartBundler` is `false`, so `startAsync({ headless: true })` calls
  `startHeadlessAsync`, which creates a *mock* dev server (no port bind, no Metro process —
  the source comment says this exists "to estimate URLs for a server started in another
  process… where you can reuse the server from a previous run"). `manager.stopAsync()` then
  closes only that mock and kills the adb server; it cannot touch the separate `expo start`
  process that owns port 8081. The debug app (no `expo-dev-client`; plain debug build) fetches
  its JS bundle from the dev-server host baked via gradle `-PreactNativeDevServerPort=8081`,
  and RN's emulator host alias (`10.0.2.2`) reaches the host loopback independently of adb
  reverse — so the post-launch `adb kill-server` cannot strand the app. The post-build
  `meteor_serving` check turns this into an enforced invariant.
- **AC3 (reviewer test matrix in both harnesses) remains met** (commit `398db3c`), and the
  shared contract in `agent-team/src/prompts/guardrails.md` documents the conditional Maestro
  step, the self-provisioning runner, and the fail-fast environment-gap rule.
- **Docs remain consistent**: `docs/architecture/agent-dev-team.md` (Native Android E2E
  section), `docs/architecture/frontend.md` (§ Native E2E incl. the new Metro-lifecycle
  paragraph), `README.md`, and `bread-sheet-app/e2e/maestro/README.md` all describe the
  runner, its prerequisites, and the headless-camera fixture policy.

The only unclosed items are **environment prerequisite gaps** (no Supabase E2E credentials in
this environment — human-managed per P9-002, fabrication forbidden by the shared contract), so
a full provisioning → emulator boot → debug-build install → flow run cannot be demonstrated
here. Per the shared contract added by this ticket, that is recorded below, not treated as a
code failure.

## Coordinator Scope Check

Flagged files: `.claude/agents/dev-reviewer.md`, `README.md`,
`agent-team/src/agents/reviewer-agent.ts`, `agent-team/src/prompts/guardrails.md`,
`docs/P9-003-findings.md`, `docs/architecture/agent-dev-team.md`,
`docs/architecture/frontend.md`. All in scope: the first three/four are AC3's deliverable
(wire the Maestro step into both reviewer harnesses + the shared contract), and the rest are
the mandatory post-implementation docs (`CLAUDE.md`) plus this required reviewer artifact. The
implementer's pillar boundary was `bread-sheet-app/`; the harness/doc writes are the ticket's
explicit ask. **Not a blocker.**

## What Was Implemented (verified at this review)

- `bread-sheet-app/scripts/run-maestro-android.sh` — self-provisioning, idempotent runner:
  Android cmdline-tools / API 35 `google_apis;x86_64` system image / `bread-sheet-api-35` AVD
  under `$ANDROID_HOME` (default `~/Android/Sdk`), cached Temurin JDK 17 when the host lacks
  one, Maestro, headless emulator boot, **Metro kept alive on `8081` for the whole run (new
  this cycle)**, `expo run:android --variant debug --no-bundler`, post-build Metro check,
  then `maestro test e2e/maestro/barcode-scan.yaml`.
  - Fail-fast before any download: missing `EXPO_PUBLIC_SUPABASE_URL` /
    `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` → clear error, exit 1 (verified live this
    review: exit 1 at the credentials gate with the documented message); unreachable API →
    clear error naming the remediation, exit 1. `localhost`/`127.0.0.1`
    `EXPO_PUBLIC_API_URL` is translated to the emulator alias `10.0.2.2` with a reproducible
    default `http://10.0.2.2:3000`.
  - `bash -n` clean; runs under `npm run test:maestro`.
- `bread-sheet-app/e2e/maestro/barcode-scan.yaml` — guest sign-in → Scan tab → camera
  permission → wait for native `CameraView` hint → tap `Use test barcode` → assert Product
  route. New this cycle: a 60s `extendedWaitUntil` for the login screen before the first tap
  (cold-start bundle fetch). Selectors verified against actual app strings this review
  ("Continue as Guest" in `app/(auth)/login.tsx`; "Scan" tab title in `app/(tabs)/_layout.tsx`;
  "Allow Camera" and "Align barcode within the frame" in `app/(tabs)/scan.tsx`; "Use test
  barcode" fixture button; "Product" stack header in `app/(app)/_layout.tsx`). `appId:
  com.breadsheetexpo.breadsheet` matches `app.json` android package.
- `bread-sheet-app/app/(tabs)/scan.tsx` — debug-only `Use test barcode` fixture button
  rendered only when `__DEV__` and `EXPO_PUBLIC_MAESTRO_BARCODE` are set; it invokes the exact
  `handleBarcodeScanned` callback `expo-camera` drives (`onBarcodeScanned={…handleBarcodeScanned}`,
  verified in the source). Never in a production build. Default fixture code `4006381333931`
  is a valid EAN-13 (check digit verified).
- `bread-sheet-app/app/(tabs)/scan-screen.test.tsx` — 3 new tests pinning the fixture
  contract (hidden when env unset; valid code routes to `/(app)/product/<code>`; invalid code
  opens the pre-filled manual sheet). 10/10 in-suite, PASS this review.
- `bread-sheet-app/e2e/maestro/README.md` + `docs/architecture/frontend.md` § Native E2E —
  invocation, prerequisites, the new Metro-lifecycle section, and the documented product
  decision that the fixture proves permission + `CameraView` + callback + API lookup +
  navigation but not optical decoding (Maestro cannot inject camera frames into a headless
  AVD).
- `bread-sheet-app/package.json` — `test:maestro` script; Playwright config/e2e specs now
  skip gracefully without Supabase credentials instead of crashing.
- `.claude/agents/dev-reviewer.md`, `agent-team/src/agents/reviewer-agent.ts`,
  `agent-team/src/prompts/guardrails.md` — AC3 conditional Maestro test-matrix step + shared
  contract (commit `398db3c`).
- `README.md`, `docs/architecture/agent-dev-team.md` — native E2E documentation.

## Test Results (this review)

| Check | Result | Notes |
|---|---|---|
| `bash -n bread-sheet-app/scripts/run-maestro-android.sh` | PASS | Syntax clean. |
| `npm --prefix bread-sheet-app run typecheck` | PASS | Exit 0. |
| `npm --prefix bread-sheet-app run lint` | PASS | Exit 0; one pre-existing unused-variable warning in `app/(app)/review-edit/[editId].tsx` (untouched by this branch). |
| `npm --prefix bread-sheet-app test -- --runInBand` | PASS | 28 suites / 242 tests, exit 0; incl. `scan-screen` suite 10/10 with the 3 new fixture tests. |
| `npm --prefix bread-sheet-app run test:e2e` | PASS (2 skipped) | Exit 0; both Playwright specs skip because local Supabase E2E credentials are absent — documented graceful-skip behavior, not a web assertion. |
| `npm --prefix bread-sheet-app run test:maestro` | FAIL (fail-fast, as designed) | Exit 1 at the credentials gate with the documented error. No emulator boot or flow run possible in this environment (no Supabase creds; no `cmdline-tools` in `~/Android/Sdk`; no host JDK — the script would provision these, but the gate stops it first). Environment prerequisite gap, not a code failure. |
| `@expo/cli` headless-bundler behavior | VERIFIED FIXED | `run/resolveBundlerProps.js` → `shouldStartBundler=false` with `--no-bundler`; `BundlerDevServer.startAsync` → `startHeadlessAsync` mock (no port bind); `DevServerManager.stopAsync` closes the mock + adb server only — the runner's real `expo start` process (port 8081) is untouched. Debug app reaches Metro via the emulator's `10.0.2.2` host alias (RN `AndroidInfoHelpers`), independent of adb reverse. |
| Server typecheck/tests | NOT RUN | No `server/` files touched by the branch (backend pillar not invoked). |

## Acceptance Criteria Review

1. **Android emulator runs locally (or in CI) without manual per-run setup — MET at the
   design level; end-to-end demonstration blocked by environment.** The runner is
   self-provisioning and idempotent (SDK/AVD/JDK/Maestro on first run, headless boot, no
   per-run checklist), and the fail-fast prerequisite gates behave correctly (verified live:
   exit 1 at the credentials gate with the documented message). The last code defect that
   would have broken the run — Metro torn down before the debug app could load its bundle —
   is fixed and verified against the installed CLI source. A full provisioning → boot →
   install → flow run cannot be executed here because Supabase E2E credentials are
   human-managed and absent; per the shared contract that is an environment gap recorded
   below, not a code failure.
2. **At least one Maestro flow exercises barcode scanning end-to-end against a debug build —
   MET at the design level; live run blocked by the same environment gap.** `barcode-scan.yaml`
   is well-formed, its selectors match the app's actual UI text (verified), `appId` matches
   the debug package, the runner keeps the bundle server alive, and the fixture contract
   (same `handleBarcodeScanned` callback as `expo-camera`) is unit-tested 10/10. The
   fixture-vs-optical-decode product decision is documented and accepted.
3. **Reviewer test matrix in both harnesses runs Maestro for camera/scan tickets — MET.**
   Both `.claude/agents/dev-reviewer.md` and `agent-team/src/agents/reviewer-agent.ts`
   contain the conditional `npm --prefix bread-sheet-app run test:maestro` step (triggered by
   a camera/scan-touching diff), and `agent-team/src/prompts/guardrails.md` documents the
   trigger, the self-provisioning runner, and the fail-fast environment-gap handling.
   Verified at branch tip.

## Open Questions / Environment Gaps (non-blocking, recorded per shared contract)

1. **Demonstrate one successful `npm --prefix bread-sheet-app run test:maestro` run** in an
   environment with configured Supabase E2E credentials and a running local API
   (`cd server && npm run dev`), reaching the final Product-route assertion. In this
   environment the runner exits 1 at the credentials gate by design (verified); credentials
   must be supplied by a human, never fabricated. This closes the remaining AC1/AC2 evidence
   gap.
2. **Re-run the Playwright web specs in a configured-credentials environment** so they
   execute rather than skip (graceful skip is an improvement; a green run is the real
   evidence). Not a blocker on its own.
3. **Optional follow-up:** consider an ADR (per `CLAUDE.md` mandatory steps) recording the
   native-E2E infrastructure choice and the fixture-vs-optical-decode decision; the decision
   is already fully documented in `docs/architecture/agent-dev-team.md` and
   `docs/architecture/frontend.md`, so this is documentation polish, not a blocker.

Resolved since the last review: Metro-lifecycle defect in `run-maestro-android.sh` (was
Open Question 1 — fixed, verified against `@expo/cli` source); AC3 harness wiring in both
harnesses + shared contract (was open question #1 of an earlier cycle — verified at branch
tip); stale "not built" docs replaced (verified).

## Review Summary

All three acceptance criteria are met at the code/design level, the actionable Metro-lifecycle
defect from the previous review is fixed and verified against the installed CLI source, the
full runnable test matrix is green (typecheck, lint, 242 unit tests incl. the new fixture
contract, Playwright e2e with documented graceful skips), AC3 is wired into both harnesses and
the shared contract, and the documentation is consistent. The only unclosed items are
environment prerequisite gaps (no human-managed Supabase E2E credentials here), which the
shared contract this ticket introduced says to record rather than treat as a code failure.
**PASS.** PR opened; the findings doc and `FEATURES.md` checkboxes are committed, along with
the implementer's uncommitted Metro-lifecycle fix so the PR reflects the reviewed state.

## Reviewer Sign-off

**Reviewer:** Agentic dev-team reviewer
**Decision:** PASS

---

## Appendix: Files Reviewed

- `bread-sheet-app/scripts/run-maestro-android.sh` (incl. the new Metro-lifecycle fix; syntax
  and fail-fast gates verified live)
- `bread-sheet-app/e2e/maestro/barcode-scan.yaml` (selectors verified against app UI text;
  `appId` matches `app.json`)
- `bread-sheet-app/e2e/maestro/README.md`, `README.md`
- `bread-sheet-app/app/(tabs)/scan.tsx`, `app/(tabs)/scan-screen.test.tsx`
- `bread-sheet-app/package.json`, `bread-sheet-app/playwright.config.ts`
- `bread-sheet-app/e2e/auth.spec.ts`, `bread-sheet-app/e2e/scan-tab.spec.ts`
- `.claude/agents/dev-reviewer.md` (AC3 — met), `agent-team/src/agents/reviewer-agent.ts`
  (AC3 — met), `agent-team/src/prompts/guardrails.md` (shared contract — Native E2E section)
- `docs/architecture/agent-dev-team.md`, `docs/architecture/frontend.md`
- `@expo/cli` build source (`run/android/runAndroidAsync.js`, `run/resolveBundlerProps.js`,
  `run/startBundler.js`, `start/server/BundlerDevServer.js`,
  `start/server/DevServerManager.js`, `start/platforms/android/AndroidPlatformManager.js`,
  `ADBServer.js`, `gradle.js`) — verified the Metro-reuse and headless-mock claims
