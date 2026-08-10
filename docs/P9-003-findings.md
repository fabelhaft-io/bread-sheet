# P9-003 Findings — Android Emulator + Maestro E2E Coverage

**Status:** BLOCKED
**Date:** 2026-05-21
**Branch:** `agent/P9-003` (target: `feat/agentic-dev-team`)
**Ticket:** [TICKET-P9-003] Android Emulator + Maestro E2E Coverage

---

## Current State

The implementation adds a local `test:maestro` command, an Android runner, a Maestro YAML flow,
and a debug-only barcode fixture button. It does not satisfy the ticket's acceptance criteria yet.
The two reviewer harnesses and the architecture documentation were not updated, and the native
flow was not executed successfully in this worktree.

## What Was Implemented

- `bread-sheet-app/scripts/run-maestro-android.sh` attempts to provision Android command-line
tools, an API 35 system image/AVD, Maestro, a debug APK, and the flow.
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
| `npm --prefix bread-sheet-app run test:e2e` | FAIL | Both Playwright specs timed out waiting for `Continue as Guest` in this environment. |
| `npm --prefix bread-sheet-app run test:maestro` | FAIL/BLOCKED | Runner stopped before provisioning: `Java 17+ is required by Android SDK tools`; no successful emulator or Maestro run was demonstrated. |
| Server tests/typecheck | NOT RUN | No server files were touched. |

## Acceptance Criteria Review

1. **Android emulator runs locally or in CI without manual per-run setup — NOT MET.** The checked-in
script is a promising bootstrap, but this review could not execute it. There is no CI-hosted emulator
workflow, and the README still requires the app API to be separately reachable from the emulator.
The ticket requires a reproducible setup, not merely a script that exits when host prerequisites or
external service setup are absent.

2. **At least one Maestro flow exercises barcode scanning end-to-end against a debug build — NOT
VERIFIED / NOT MET.** The flow is present and requests a debug build, but it invokes a debug-only
button rather than decoding a camera-provided barcode, and no successful run against an installed
debug build was produced. The flow also depends on an API reachable from the emulator for its final
assertion.

3. **Both reviewer roles run Maestro for camera/scan tickets — NOT MET.** Neither
`.claude/agents/dev-reviewer.md` nor `agent-team/src/agents/reviewer-agent.ts` contains a conditional
Maestro test-matrix command. Both still describe/run only the Playwright E2E step. Their instructions
also still reference `main` instead of this harness's required base branch where applicable.

## Required Fixes / Open Questions

1. Choose and check in a reproducible provisioning strategy: a CI emulator job/action, or a fully
automated local bootstrap that also establishes the debug build, API endpoint, and deterministic
barcode/camera input. Demonstrate one successful run.
2. Add a conditional `npm --prefix bread-sheet-app run test:maestro` step to both reviewer harnesses
for tickets touching camera or scan code, while preserving the shared contract and base branch
`feat/agentic-dev-team` in this harness.
3. Update `docs/architecture/agent-dev-team.md` to replace the stale “not built yet” follow-up with
the selected provisioning, invocation, and prerequisite policy.
4. Re-run the full UI matrix after the native setup is fixed or its environment prerequisites are
made reproducible; the current Playwright matrix is not green.

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
- Reviewer findings update pending commit.
