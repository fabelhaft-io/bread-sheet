# P9-003 Findings — Android Emulator + Maestro E2E Coverage

**Status:** BLOCKED
**Date:** 2026-05-21
**Branch:** `agent/P9-003` (target: `feat/agentic-dev-team`)
**Ticket:** [TICKET-P9-003] Android Emulator + Maestro E2E Coverage

---

## Current State

The implementation adds a self-provisioning Android/Maestro shell entry point, a Maestro YAML
flow, and a development-only deterministic barcode callback fixture. The branch does not yet
close the ticket: neither reviewer harness runs Maestro conditionally, the architecture document
still describes Android/Maestro as not built, and no successful native flow execution is evidenced.
The coordinator scope-check file `docs/P9-003-findings.md` is in scope because it is the required
reviewer findings artifact; the other changed files are frontend/native test infrastructure in
scope for this ticket.

## What Was Implemented

- `bread-sheet-app/scripts/run-maestro-android.sh` attempts to provision command-line Android
  tools, an API 35 system image/AVD, Java 17, Maestro, a debug APK, and the flow.
- `bread-sheet-app/e2e/maestro/barcode-scan.yaml` launches the app, signs in as guest, opens Scan,
  grants camera permission, taps `Use test barcode`, and asserts the Product route.
- `bread-sheet-app/app/(tabs)/scan.tsx` exposes `Use test barcode` only in a development build
  when `EXPO_PUBLIC_MAESTRO_BARCODE` is set, using the same handler as the camera callback.
- `bread-sheet-app/e2e/maestro/README.md` documents local invocation and emulator prerequisites.
- `bread-sheet-app/package.json` adds `test:maestro`.

## Test Results

| Check | Result | Notes |
|---|---|---|
| `npm --prefix bread-sheet-app run typecheck` | PASS | Exit code 0. |
| `npm --prefix bread-sheet-app run lint` | PASS | Exit code 0; one pre-existing `no-unused-vars` warning in `app/(app)/review-edit/[editId].tsx`. |
| `npm --prefix bread-sheet-app test -- --runInBand` | PASS | Exit code 0. |
| `npm --prefix bread-sheet-app run test:e2e` | FAIL | Both existing Playwright tests timed out waiting for `Continue as Guest` (30 seconds). |
| `npm --prefix bread-sheet-app run test:maestro` | NOT RUN | Native SDK/emulator/Maestro execution was not available for this review; no successful native run was demonstrated. |
| Server typecheck/tests | NOT RUN | No server files were touched. |

## Acceptance Criteria Review

1. **Android emulator runs locally or in CI without manual per-run setup — NOT VERIFIED / NOT MET.**
   The checked-in script is intended to bootstrap dependencies and is idempotent, but there is no
   CI-hosted emulator workflow or successful execution evidence. The README also requires the app
   API to be reachable from the emulator, without providing a checked-in service/bootstrap path.

2. **At least one Maestro flow exercises barcode scanning end-to-end against a debug build — NOT
   VERIFIED / NOT MET.** A YAML flow and debug-build command exist, but the flow taps a debug-only
   callback fixture rather than decoding a camera-provided barcode. The final Product assertion
   additionally depends on an API reachable from the emulator. Either provide a reproducible real
   camera/barcode input strategy, or record and implement an explicit product/test decision that
   the same-callback fixture satisfies this acceptance criterion, then demonstrate a successful run.

3. **Both reviewer roles run Maestro for camera/scan tickets — NOT MET.** Neither
   `.claude/agents/dev-reviewer.md` nor `agent-team/src/agents/reviewer-agent.ts` contains a
   conditional `npm --prefix bread-sheet-app run test:maestro` test-matrix command. The base
   architecture document still says Android/Maestro is “not built yet”.

## Required Fixes / Open Questions

1. Add a conditional Maestro test-matrix step to both reviewer harnesses for tickets touching
   camera/scan code, while preserving the shared guardrails and this run's base branch
   `feat/agentic-dev-team`.
2. Fix/document the complete provisioning and API prerequisite path, and demonstrate one successful
   `npm --prefix bread-sheet-app run test:maestro` run that provisions or reuses the emulator,
   installs the debug build, and completes the flow without a manual per-run checklist.
3. Decide whether the debug callback fixture is acceptable evidence for “barcode scanning
   end-to-end”. If not, provide a camera-frame/virtual-camera or CI/device strategy that performs
   a real EAN-13 decode. If yes, document that decision and make the evidence prove the callback and
   navigation path against the installed debug build.
4. Update `docs/architecture/agent-dev-team.md` to replace the stale “not built yet” follow-up with
   the selected provisioning, invocation, and prerequisite policy.
5. Re-run the full UI matrix after the native setup is reproducible; the current Playwright matrix
   is not green.

Per the shared contract, this review is blocked and no PR should be opened.

---

## Review Summary

The branch is a useful local starting point, but reviewer integration, architecture documentation,
reproducible native execution, native barcode evidence, and the existing UI E2E baseline remain
incomplete. **BLOCKED.**

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
- `.claude/agents/dev-reviewer.md`
- `agent-team/src/agents/reviewer-agent.ts`
- `docs/architecture/agent-dev-team.md`
- `agent-team/src/prompts/guardrails.md`

**BLOCKED**
