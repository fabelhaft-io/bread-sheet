# P9-003 Findings — Android Emulator + Maestro E2E Coverage

**Status:** BLOCKED
**Date:** 2026-05-21
**Branch:** `agent/P9-003` (target: `feat/agentic-dev-team`)
**Ticket:** [TICKET-P9-003] Android Emulator + Maestro E2E Coverage

---

## Current State

The branch adds a local Maestro command, an Android runner, a YAML flow, and a development-only
barcode fixture. It does not satisfy the acceptance criteria yet. Neither reviewer harness was
updated with the required conditional Maestro step, the architecture follow-up remains marked as
not built, and no successful native flow run was demonstrated.

## What Was Implemented

- `bread-sheet-app/scripts/run-maestro-android.sh` attempts to provision Android command-line
tools, an API 35 system image/AVD, Java 17, Maestro, a debug APK, and the flow.
- `bread-sheet-app/e2e/maestro/barcode-scan.yaml` launches the app, signs in as guest, opens Scan,
grants camera permission, uses the debug fixture, and asserts navigation to Product.
- `bread-sheet-app/app/(tabs)/scan.tsx` exposes `Use test barcode` only for a development build
when `EXPO_PUBLIC_MAESTRO_BARCODE` is set; it calls the same handler used by the camera callback.
- `bread-sheet-app/e2e/maestro/README.md` documents local invocation and emulator/API prerequisites.
- `bread-sheet-app/package.json` adds `test:maestro`.

## Test Results

| Check | Result | Notes |
|---|---|---|
| `npm --prefix bread-sheet-app run typecheck` | PASS | Exit code 0. |
| `npm --prefix bread-sheet-app run lint` | PASS with existing warning | One existing `no-unused-vars` warning in `app/(app)/review-edit/[editId].tsx`; no errors. |
| `npm --prefix bread-sheet-app test -- --runInBand` | PASS | Exit code 0. |
| `npm --prefix bread-sheet-app run test:e2e` | FAIL | Both existing Playwright specs timed out waiting for `Continue as Guest` in this environment. |
| `npm --prefix bread-sheet-app run test:maestro` | FAIL/BLOCKED | The bootstrap downloaded Java, then exited at line 51 because the Java-version extraction at line 49 assigns literal `\1` (arithmetic syntax error). No emulator, debug APK, or Maestro flow run was completed. |
| Server tests/typecheck | NOT RUN | No server files were touched. |

## Acceptance Criteria Review

1. **Android emulator runs locally or in CI without manual per-run setup — NOT MET.** The checked-in
script is intended to bootstrap dependencies, but it failed before SDK provisioning in this review.
There is also no CI-hosted emulator workflow, and the README requires the app API to be separately
reachable from the emulator.

2. **At least one Maestro flow exercises barcode scanning end-to-end against a debug build — NOT
VERIFIED / NOT MET.** A flow is present and requests a debug build, but it invokes a debug-only
fixture rather than decoding a camera-provided barcode. No successful run against an installed
debug build was produced. The final assertion also depends on an API reachable from the emulator.
The fixture may be a valid deterministic strategy, but the ticket does not document acceptance of
simulated callback input in place of an end-to-end barcode scan; this requires either real camera
input or an explicit product/test decision.

3. **Both reviewer roles run Maestro for camera/scan tickets — NOT MET.** Neither
`.claude/agents/dev-reviewer.md` nor `agent-team/src/agents/reviewer-agent.ts` contains a
conditional `npm --prefix bread-sheet-app run test:maestro` test-matrix command. The architecture
document still says Android/Maestro is “not built yet”.

## Required Fixes / Open Questions

1. Fix and test the Java-version extraction/bootstrap path, then demonstrate one successful
`npm --prefix bread-sheet-app run test:maestro` run that provisions or reuses the emulator,
installs the debug build, and completes the flow. Ensure the API endpoint and deterministic barcode
input are reproducible without a manual per-run checklist.
2. Decide whether the debug fixture is acceptable evidence for “barcode scanning end-to-end”. If it
is not, provide a camera-frame fixture/virtual camera or a CI/device strategy that performs a real
EAN-13 decode. If it is, document that product decision and make the flow assertion prove the
callback/navigation path against the debug build.
3. Add a conditional Maestro test-matrix step to both reviewer harnesses for tickets touching
camera/scan code, while preserving the shared contract and base branch `feat/agentic-dev-team` in
this harness.
4. Update `docs/architecture/agent-dev-team.md` to replace the stale “not built yet” follow-up with
the selected provisioning, invocation, and prerequisite policy.
5. Re-run the full UI matrix after native setup is fixed or its environment prerequisites are made
reproducible; the current Playwright matrix is not green.

Per the shared contract, this review is blocked and no PR should be opened. Two fix cycles remain.

---

## Review Summary

The branch is a useful local starting point, but provisioning/reproducibility, successful native
barcode evidence, reviewer integration, and architecture documentation are incomplete.
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
- `.claude/agents/dev-reviewer.md`
- `agent-team/src/agents/reviewer-agent.ts`
- `docs/architecture/agent-dev-team.md`
- `agent-team/src/prompts/guardrails.md`

---

## Commit Log

- `b3a634a` — test: add Android Maestro barcode flow (implementer)
- `81d1ed9` — test(android): provision Java for Maestro runner (implementer)
- Reviewer findings update pending commit.

**BLOCKED**
