# P9-003 Findings — Android Emulator + Maestro E2E Coverage

**Status:** BLOCKED  
**Date:** 2026-05-21  
**Branch:** `agent/P9-003` (target: `feat/agentic-dev-team`)  
**Ticket:** [TICKET-P9-003] Android Emulator + Maestro E2E Coverage

---

## Current State

The branch adds a `test:maestro` package script, an Android runner shell script, and one
`e2e/maestro/barcode-scan.yaml` flow. However, the acceptance criteria are not closed:

- The runner does not install Android command-line tools or Maestro; it exits when either is
  missing. There is no CI emulator job or other checked-in provisioning path.
- The flow requires a human to configure the emulator camera with a barcode fixture before each
  run, and requires a separately reachable API. Therefore it is not a reproducible end-to-end
  debug-build test without manual per-run setup.
- Neither reviewer harness was updated to invoke `npm --prefix bread-sheet-app run test:maestro`
  for camera/scan tickets. Both still contain only the Playwright E2E step.
- `docs/architecture/agent-dev-team.md` still says Android/Maestro is “not built yet” and has not
  been updated to describe the new runner or reviewer matrix.

No ticket checkboxes were changed and no PR was opened.

## What Was Implemented

- Added `bread-sheet-app/scripts/run-maestro-android.sh`, which checks for an existing SDK and
  Maestro installation, installs API 35 packages when those tools exist, creates/boots an AVD,
  builds the Expo debug variant, and invokes the flow.
- Added `bread-sheet-app/e2e/maestro/barcode-scan.yaml`, which launches the app, signs in as a
  guest, opens Scan, grants camera permission, waits for the camera UI, and asserts navigation to
  a Product screen after a scan callback.
- Added local usage notes in `bread-sheet-app/e2e/maestro/README.md` and the `test:maestro`
  npm script.

## Test Results

| Check | Result | Notes |
|---|---|---|
| `npm --prefix bread-sheet-app run typecheck` | PASS | No diagnostics/output. |
| `npm --prefix bread-sheet-app run lint` | PASS with existing warning | One `no-unused-vars` warning in `app/(app)/review-edit/[editId].tsx`; no errors. |
| `npm --prefix bread-sheet-app test -- --runInBand` | PASS | No diagnostics/output; exit code 0. |
| `npm --prefix bread-sheet-app run test:e2e` | FAIL | Both existing Playwright specs timed out waiting for `Continue as Guest`, so the UI matrix is not green in this worktree/environment. |
| `npm --prefix bread-sheet-app run test:maestro` | BLOCKED/FAIL | Runner exited before provisioning: missing `/home/jano/Android/Sdk/tools/bin/sdkmanager`. No Android SDK/emulator is available. |
| Server tests/typecheck | NOT RUN | No server files were touched; ticket is frontend/native test infrastructure. |

## Acceptance Criteria Review

1. **Android emulator runs locally or in CI without manual per-run setup — NOT MET.** The script
   assumes Android SDK command-line tools and Maestro were installed manually, has no CI-hosted
   emulator workflow, and README requires manually configuring a barcode camera fixture and API
   reachability.
2. **At least one Maestro flow exercises barcode scanning end-to-end against a debug build — NOT
   VERIFIED / NOT MET.** The YAML describes the intended path and the script requests a debug
   build, but it cannot run in this environment and depends on a human-provided camera frame and
   external API. There is no automated fixture or successful run artifact/evidence.
3. **Both reviewer roles run Maestro for camera/scan tickets — NOT MET.**
   `.claude/agents/dev-reviewer.md` and `agent-team/src/agents/reviewer-agent.ts` have not been
   changed and contain no Maestro test-matrix step or camera/scan conditional.

## Open Questions / Required Fixes

1. Should the project provide a checked-in CI workflow/action that provisions the Android SDK,
   AVD, Maestro, debug APK, API endpoint, and deterministic camera/barcode fixture, or is a
   documented local bootstrap script acceptable? The acceptance criterion requires no manual
   per-run setup, so the chosen path must automate the camera input and API prerequisites too.
2. Add the Maestro command to both reviewer prompts, conditionally for tickets touching camera or
   scan code (and use the ticket base `feat/agentic-dev-team` in this harness's instructions).
3. Update `docs/architecture/agent-dev-team.md` so it no longer describes Maestro as unbuilt and
   documents provisioning, invocation, and prerequisites.
4. Re-run the native flow successfully against the debug build and capture the deterministic
   barcode fixture/API setup in the implementation documentation. Re-run Playwright after fixing
   or documenting the current authentication environment failure.

Per the shared contract, this review is blocked; no PR should be opened until the concrete gaps
above are resolved.

## Follow-ups (out of scope for this blocked review)

- Consider making the runner clean up an emulator it started and isolate the ADB target, so an
  unrelated running emulator cannot be selected accidentally.
- Consider making the scanned barcode an explicit test fixture/configuration rather than relying on
  the generic `Product` text assertion.

---

## Review Summary

The implementation is a useful local starting point, but it does not yet satisfy the required
provisioning, deterministic native E2E, reviewer integration, or documentation acceptance criteria.
**BLOCKED.**

## Final Status

**BLOCKED** — missing automated provisioning/deterministic camera setup, missing reviewer-matrix
changes in both harnesses, stale architecture documentation, and no successful Maestro run.
2 fix cycles are available under the shared contract.

---

## Commit Log

- `b3a634a` — test: add Android Maestro barcode flow (implementer)
- Reviewer findings pending commit.

---

## Reviewer Sign-off

**Reviewer:** Agentic dev-team reviewer  
**Decision:** BLOCKED

---

## Human Decision Required

Choose and implement a reproducible provisioning strategy (CI emulator or a fully automated local
bootstrap including deterministic camera/API fixtures), then update both reviewer harnesses and the
architecture documentation before requesting another review.

---

## Appendix: Files Reviewed

- `bread-sheet-app/e2e/maestro/barcode-scan.yaml`
- `bread-sheet-app/e2e/maestro/README.md`
- `bread-sheet-app/scripts/run-maestro-android.sh`
- `bread-sheet-app/package.json`
- `.claude/agents/dev-reviewer.md`
- `agent-team/src/agents/reviewer-agent.ts`
- `docs/architecture/agent-dev-team.md`

---

## Reproduction

```sh
cd bread-sheet-app
npm run test:maestro
# Missing Android SDK tool: .../Android/Sdk/tools/bin/sdkmanager
```

The full diff was reviewed with:

```sh
git diff feat/agentic-dev-team...HEAD
```

---

## Contract Check

- No application source was edited by the reviewer.
- No `FEATURES.md` checkbox was checked because acceptance criteria failed.
- No PR was created.
- Findings are recorded for the bounded implementer retry cycle.

---

## End

**BLOCKED**
