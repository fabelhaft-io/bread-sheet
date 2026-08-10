# P9-003 Findings — Android Emulator + Maestro E2E Coverage

**Status:** BLOCKED  
**Date:** 2026-05-21  
**Branch:** `agent/P9-003` (target: `feat/agentic-dev-team`)  
**Ticket:** [TICKET-P9-003] Android Emulator + Maestro E2E Coverage

---

## Current State

The branch adds a Maestro flow, a local Android/AVD provisioning script, and a development-only
barcode callback fixture. It does not close the ticket. The two reviewer harnesses do not add a
conditional Maestro test-matrix step, the architecture document still describes Android/Maestro as
not built, and the native flow could not be executed successfully in this review.

The coordinator scope-check file `docs/P9-003-findings.md` is in scope because it is the required
reviewer artifact. The other changed files are frontend/native test infrastructure and are in scope
for this ticket.

## What Was Implemented

- `bread-sheet-app/scripts/run-maestro-android.sh` attempts to provision command-line Android
  tools, an API 35 system image/AVD, Java 17, Maestro, a debug APK, and the flow.
- `bread-sheet-app/e2e/maestro/barcode-scan.yaml` launches the app, signs in as guest, opens Scan,
  grants camera permission, taps `Use test barcode`, and asserts the Product route.
- `bread-sheet-app/app/(tabs)/scan.tsx` exposes `Use test barcode` in development when
  `EXPO_PUBLIC_MAESTRO_BARCODE` is set, using the same callback as `expo-camera`.
- `bread-sheet-app/e2e/maestro/README.md` documents invocation and prerequisites.
- `bread-sheet-app/package.json` adds `test:maestro`.
- The Playwright config/spec changes make local web auth tests skip when Supabase credentials are
  absent, and add accessibility/test hooks for the scan flow.

## Test Results

| Check | Result | Notes |
|---|---|---|
| `npm --prefix bread-sheet-app run typecheck` | PASS | Exit code 0. |
| `npm --prefix bread-sheet-app run lint` | PASS | Exit code 0; one pre-existing unused-variable warning in `app/(app)/review-edit/[editId].tsx`. |
| `npm --prefix bread-sheet-app test -- --runInBand` | PASS | Exit code 0. |
| `npm --prefix bread-sheet-app run test:e2e` | PASS (2 skipped) | Exit code 0, but both Playwright tests skipped because local Supabase E2E credentials are not configured; this is not evidence of a successful web assertion. |
| `npm --prefix bread-sheet-app run test:maestro` | FAIL | Exit code 1 before SDK provisioning. The script's Java-version `sed` expression produces the literal `\\1`, resulting in `((: \\1: arithmetic syntax error))` and then `Java 17+ is required`. No emulator or Maestro flow run was demonstrated. |
| Server typecheck/tests | NOT RUN | No server files were touched. |

## Acceptance Criteria Review

1. **Android emulator runs locally or in CI without manual per-run setup — NOT MET / NOT VERIFIED.**
   The checked-in script is intended to bootstrap dependencies, but it currently fails before
   provisioning on a host without Java. It also requires the app API to be made reachable from the
   emulator manually; no checked-in API service/bootstrap or CI workflow provides that prerequisite.

2. **At least one Maestro flow exercises barcode scanning end-to-end against a debug build — NOT
   MET / NOT VERIFIED.** A YAML flow and debug-build command exist, but the flow taps a debug-only
   callback fixture rather than feeding a camera frame and performing an optical barcode decode.
   The final Product assertion also depends on an API reachable from the emulator. No successful
   native run against the installed debug build was evidenced. A product/test decision is needed
   on whether a same-callback fixture is acceptable for this acceptance criterion; otherwise a
   camera-frame/virtual-camera or CI/device strategy is required.

3. **Both reviewer roles run Maestro for camera/scan tickets — NOT MET.** Neither
   `.claude/agents/dev-reviewer.md` nor `agent-team/src/agents/reviewer-agent.ts` contains the
   required conditional `npm --prefix bread-sheet-app run test:maestro` test-matrix step. The
   architecture document still says Android/Maestro is “not built yet”.

## Required Fixes / Open Questions

1. Add a conditional Maestro test-matrix step to both reviewer harnesses for tickets whose diff
   touches camera/scan code. The condition should be explicit and should preserve the shared
   guardrails and this run's base branch `feat/agentic-dev-team`.
2. Correct and test the Java-version extraction/provisioning path in
   `run-maestro-android.sh`; then demonstrate one successful `npm --prefix bread-sheet-app run
   test:maestro` run that provisions or reuses the emulator, installs the debug build, and
   completes the flow without a manual per-run checklist.
3. Provide a reproducible API prerequisite path for the Product assertion (for example, start a
   checked-in local service accessible from the emulator or use a CI service), rather than asking
   the operator to arrange emulator networking manually.
4. Decide whether the debug callback fixture is acceptable evidence for “barcode scanning
   end-to-end”. If not, provide a real EAN-13 camera input/virtual-camera or device strategy. If
   yes, document that product decision and make the successful-run evidence prove the callback and
   navigation path against the installed debug build.
5. Update `docs/architecture/agent-dev-team.md` to replace the stale “not built yet” follow-up with
   the selected provisioning, invocation, API prerequisite, and camera-input policy.
6. Re-run the full UI matrix in an environment with configured E2E credentials so the Playwright
   tests execute rather than merely skip.

Per the shared contract, this review is blocked and no PR should be opened.

---

## Review Summary

The branch is a useful local starting point, but reviewer integration, executable native setup,
API reproducibility, native barcode evidence, and architecture documentation remain incomplete.
**BLOCKED.**

## Reviewer Sign-off

**Reviewer:** Agentic dev-team reviewer  
**Decision:** BLOCKED

---

## Appendix: Files Reviewed

- `bread-sheet-app/app/(tabs)/scan.tsx`
- `bread-sheet-app/e2e/maestro/barcode-scan.yaml`
- `bread-sheet-app/e2e/maestro/README.md`
- `bread-sheet-app/scripts/run-maestro-android.sh`
- `bread-sheet-app/package.json`
- `bread-sheet-app/playwright.config.ts`
- `.claude/agents/dev-reviewer.md`
- `agent-team/src/agents/reviewer-agent.ts`
- `docs/architecture/agent-dev-team.md`
- `agent-team/src/prompts/guardrails.md`

**BLOCKED**
