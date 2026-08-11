# P9-003 Findings — Android Emulator + Maestro E2E Coverage

**Date:** 2026-08-11 (human review of PR #110, superseding the 2026-08-10 agent reviewer run)
**Branch:** `agent/P9-003` (base: `main`)
**Ticket:** [TICKET-P9-003] Android Emulator + Maestro E2E Coverage
**Status:** ❌ BLOCKED — 4 defects, each of which independently prevents the suite from running

> **Supersedes the earlier `✅ PASS` verdict on this same branch.** That verdict was reached
> without the runner ever completing a single run: every prerequisite gate failed on the review
> machine, the reviewer recorded that as an "environment prerequisite gap" per the guardrails,
> and passed the ticket on static inspection plus the jest suite. The four defects below all sit
> past the gate the reviewer reached, and the two new jest tests cannot catch the one in
> `scan.tsx` by construction. See "Why the earlier run passed this" at the bottom — that part is
> a harness lesson, not an implementer task.

---

## Current State

Before this ticket, native-only flows (camera, barcode scan, on-device OCR) were covered
only structurally — Playwright/Expo-web cannot drive them (headless Chromium has no camera,
per `e2e/scan-tab.spec.ts`). The reviewer test-matrix wiring for a conditional Maestro step
was already in place in both harnesses (`.claude/agents/dev-reviewer.md`,
`agent-team/src/agents/reviewer-agent.ts`, and the shared contract in
`agent-team/src/prompts/guardrails.md`), but it was a no-op: it only fires when
`bread-sheet-app/package.json` exposes a `test:maestro` script, which did not exist.

## What Was Implemented

All changes are confined to the `bread-sheet-app/` pillar plus `docs/architecture/frontend.md`.

- **`package.json`** — added `"test:maestro": "node scripts/test-maestro.js"`, the exact
  script name the reviewer harnesses' conditional step was already waiting on.
- **`scripts/test-maestro.js`** (self-provisioning runner) — resolves the Android SDK and a
  JDK, ensures an AVD, boots a headless emulator, runs `expo prebuild` +
  `gradlew :app:installDebug`, starts Metro with `adb reverse`, wipes app data and pre-grants
  CAMERA, runs `maestro test e2e/maestro`, and tears everything down. Prerequisite failures
  exit 2 with distinct actionable messages; `MAESTRO_INSTALL` / `MAESTRO_SKIP_ENV_CHECK` /
  `MAESTRO_AVD` / timeouts are env-overridable. **Defects 1, 3 and 4 below are in this file.**
- **`e2e/maestro/barcode-scan.yaml`** — guest sign-in → Scan tab → camera UI live (waits on the
  new `scan-torch` testID) → `openLink: breadsheet://scan?inject=4006381333931` → product
  screen. **Defect 5 (weak assertion) is in this file.**
- **`e2e/maestro/manual-entry.yaml`** — the camera-free manual-entry path (P6-006).
  **Defect 5 also applies here.**
- **`app/(tabs)/scan.tsx`** — scan handling extracted into a shared `processScan` `useCallback`
  (the camera's `onBarcodeScanned` delegates to it), plus a `__DEV__`-only injection seam
  driven by `breadsheet://scan?inject=<barcode>`, and a `scan-torch` testID.
  **The single-funnel design is right and should be kept. Defect 2 is in the seam's effect.**
- **`app/(tabs)/scan-screen.test.tsx`** — two jest tests for the injection seam.
  **Both are false greens — see defect 2.**
- **`scripts/test-maestro-wiring.test.js`** — static wiring guard (npm script string, runner
  parses via `node --check`, flows target the app id). Sound as far as it goes.
- **`.gitignore`** — `/e2e/maestro/artifacts/`.
- **`docs/architecture/frontend.md`** — "Native E2E: Android emulator + Maestro" section.

## Blocking Defects

Each was reproduced on the maintainer's machine (`/home/jano`, CachyOS) on 2026-08-11.

### 1. `scripts/test-maestro.js:449` — missing `await`; the runner can never pass the build step

```js
function buildAndInstallDebug(sdk, java) {            // not async
  const res = runStreaming(gradlew, [':app:installDebug', '-x', 'lint'], { … });  // Promise
  if (res.code !== 0) fail(`Gradle :app:installDebug failed (exit ${res.code}).`, res.code || 1);
```

`res` is a Promise, so `res.code` is `undefined`, `undefined !== 0` is always true, and every
run aborts with `Gradle :app:installDebug failed (exit undefined)` (exit 1) while the Gradle
child keeps running orphaned. Confirmed by isolating the same call shape:

```
res.code = undefined | res.code !== 0 → true | fail() exit code arg: 1
```

**Fix:** make `buildAndInstallDebug` async, `await runStreaming(...)`, and `await` the call at
`:516`. Then audit the file for any other un-awaited `runStreaming`.

### 2. `app/(tabs)/scan.tsx:88-99` — the injection seam cancels its own scan

```js
router.setParams({ inject: undefined });
const id = setTimeout(() => processScan(inject), 0);
return () => clearTimeout(id);
}, [inject]);
```

`setParams` removes the param → `inject` changes → React re-renders and runs the effect
cleanup → `clearTimeout` kills the pending `processScan` before the 0 ms timer fires. The
injected scan never reaches `router.push`, so `barcode-scan.yaml` can never pass.

**Reproduced:** running the PR's own scenario against an `expo-router` mock whose `setParams`
actually updates the params and re-renders (i.e. real router behaviour), `router.push` was
called **0 times**.

**Why the PR's tests don't catch it:** `scan-screen.test.tsx` sets
`mockParams.mockReturnValue({ inject: … })` and never changes it, so the component never
re-renders on `setParams`, the effect never re-runs, and the cleanup path is never executed.
The mock freezes precisely the state the code under test mutates.

**Fix:** track consumption in a `useRef` (e.g. `consumedInject.current`) and drop the
`clearTimeout` cleanup — or call `processScan(inject)` directly and let `scanLock` plus the ref
handle re-entry. Then make the test drive it through a router mock where `setParams` actually
mutates the params, so the regression is covered rather than mocked away.

### 3. `scripts/test-maestro.js:511-516` — `pm clear` / `pm grant` run before `installDebug`

On a first run the package isn't installed yet, so both adb calls fail (their status is
discarded) and the CAMERA pre-grant never lands. On every subsequent run the app data is never
wiped, so the guest session from the previous run survives, the app boots straight into the tabs
and both flows time out on `visible: "Continue as Guest"` — i.e. the suite is not repeatable,
which is exactly what acceptance criterion 1 asks for.

**Fix:** move both adb calls after `buildAndInstallDebug`, or drop them in favour of Maestro's
own `launchApp: { clearState: true }` + permission declaration in the flows.

### 4. `scripts/test-maestro.js:681-706` — AVD discovery can't see AVDs that exist

`ensureAvd` populates `existing` only from `avdmanager list avd`, which ships in cmdline-tools.
On a machine that has an SDK, a system image and an AVD but no cmdline-tools — the maintainer's
machine — `existing` is `[]`, so the "reuse an existing AVD" fallback at `:693-701` is dead code
in exactly the situation it was written for, and the documented `MAESTRO_AVD` override cannot
rescue it either:

```
$ ~/Android/Sdk/emulator/emulator -list-avds
Medium-Phone-Android-17

$ MAESTRO_SKIP_ENV_CHECK=1 MAESTRO_AVD=Medium-Phone-Android-17 node scripts/test-maestro.js
[test:maestro] Android SDK: /home/jano/Android/Sdk
[test:maestro] Java: /opt/android-studio/jbr/bin/java
[test:maestro] ERROR: No AVD named "Medium-Phone-Android-17" and no avdmanager under
               /home/jano/Android/Sdk to create one.
```

**Fix:** discover AVDs with `emulator -list-avds` (present in every SDK, needs no cmdline-tools
and no JDK) and keep `avdmanager` for *creation* only. `$ANDROID_AVD_HOME` / `~/.android/avd/*.ini`
is a reasonable secondary source.

## Non-Blocking Findings (fix in this cycle if cheap, else record as follow-ups)

5. **Both flows' assertions are falsifiable.** They assert the literal string `4006381333931`,
   which is also the manual sheet's `placeholder` (`components/manual-barcode-sheet.tsx:158`).
   If `inputText` doesn't land in the field, submit shows a validation error and the placeholder
   keeps that string on screen — `manual-entry.yaml` passes without ever reaching the product
   screen. Assert `product-screen` / `product-not-found` / `product-offline` testIDs instead.
   Note also that in the *found* state the barcode chip sits at `app/(app)/product/[barcode].tsx:792`,
   well down the ScrollView, and may not be `visible` to Maestro at all — so the "renders in
   every state" claim in the earlier findings doc does not imply "assertable in every state".
6. **`fail()` bypasses teardown.** `fail()` (`:68`) calls `process.exit`, which does not unwind
   `finally` — so every post-boot failure orphans the headless emulator and Metro. Throw a typed
   error and let `main`'s `finally` clean up.
7. **`resolveMaestro()` runs after the build** (`:520`), i.e. a missing Maestro CLI surfaces
   10–40 minutes into a run. Move it into the prerequisite phase with the SDK/JDK checks.
8. **`curl … | bash` runs by default** (`:201`), opt-*out* via `MAESTRO_INSTALL=0`. Piping a
   remote script into bash from a test command is a supply-chain surface and sits badly with this
   repo's fail-fast-and-tell-the-user convention. Invert the default: fail with the install
   command, install only on explicit `MAESTRO_INSTALL=1`.
9. **adb calls don't pin a serial.** No `-s <serial>` anywhere; any other attached device or
   emulator makes every adb call ambiguous. `adb wait-for-device` (`:398`) also has no timeout, so
   an emulator that dies during boot hangs the runner instead of hitting `BOOT_TIMEOUT_MS`.
10. **`metroChild.kill('SIGTERM')`** (`:534`) kills only the `expo` wrapper of a `detached`
    process group; leftover Metro then holds :8081 on the next run. Use `process.kill(-pid)`.
11. **The emulator boots before the 40-minute Gradle build** — idle burn for the whole build.
12. **`expo prebuild` runs only when `android/` is absent**, so a stale native project survives
    `app.json` changes.
13. **`resolveJava()` checks exit status but not major version** (carried over from the earlier
    findings doc — still valid).
14. **Docs left stale by this ticket:** `docs/architecture/agent-dev-team.md:227-240` still lists
    P9-003 as "in progress" with the flows under **Not done**, and `CLAUDE.md`'s frontend command
    list didn't gain `test:maestro`. `docs/architecture/frontend.md` was updated correctly.
15. **No CI job.** `.github/workflows/test.yml` already runs the app suites;
    `reactivecircus/android-emulator-runner` would make these flows actually execute on every PR.
    The ticket permits local-only, but as shipped the flows will never run automatically — which
    is how four blocking defects reached a green PR. **Note the pillar boundary:** the frontend
    implementer may not edit `.github/workflows/*` (guardrails "Scope"), so this one is a
    human/coordinator task, not part of the fix cycle.

## Acceptance Criteria Tracking

- [ ] **Android emulator runs locally (or in CI) without manual per-run setup.** Not met.
  Defect 1 aborts every run before the emulator is used; defect 4 refuses the AVD that exists on
  the maintainer's machine; defect 3 makes a second run fail even once the first succeeds.
- [ ] **At least one Maestro flow exercises barcode scanning end-to-end against a debug build.**
  Not met. `barcode-scan.yaml` has never executed, and defect 2 means its injection step cannot
  drive a scan as written.
- [ ] **The reviewer's already-wired conditional step actually runs.** Partially met — the script
  exists and the reviewer's conditional step does fire, but "runs" in the sense the ticket means
  (produces a real pass/fail signal about the scan flow) is not achieved while defects 1–4 stand.

## Test Results

Re-run on the maintainer's machine, 2026-08-11, at `93e4887`:

| Check | Result | Notes |
|-------|--------|-------|
| `npm --prefix server run typecheck` / `test` | not_run | server pillar untouched by this diff |
| `npm --prefix bread-sheet-app run typecheck` | ✅ pass | no errors |
| `npm --prefix bread-sheet-app run lint` | ✅ pass | 0 errors, 1 pre-existing warning outside this diff |
| `npm --prefix bread-sheet-app test` | ✅ pass | 29 suites / 244 tests — but 2 of them are false greens (defect 2) |
| GitHub CI on PR #110 | ✅ all green | server, app unit, Playwright E2E, CodeQL, GitGuardian |
| `node scripts/test-maestro.js` | ❌ exit 2 at `.env` gate | documented actionable message — correct behaviour |
| `MAESTRO_SKIP_ENV_CHECK=1 node scripts/test-maestro.js` | ❌ exit 2 at AVD gate | **defect 4** — SDK *and* JDK resolved fine; it is the AVD lookup that fails |
| Injection seam against a params-mutating router mock | ❌ `router.push` called 0 times | **defect 2** |
| `buildAndInstallDebug` call shape in isolation | ❌ always reports failure | **defect 1** |
| Full `test:maestro` run (emulator boot → flows) | **still never executed** | blocked by defects 1 and 4; needs cmdline-tools or the defect-4 fix, plus `bread-sheet-app/.env` |

**Environment note, correcting the earlier run:** the previous findings doc recorded that the
machine had no Android SDK and that `/home/jano/Android/Sdk` "did not exist when verified". It
does exist, with `emulator/`, `platform-tools/`, `licenses/`, `platforms/` and an `android-37.1`
system image, plus an AVD at `~/.android/avd/Medium-Phone-Android-17.avd`. The runner itself
resolves both the SDK and the JDK on this machine (output above). What is genuinely missing is
cmdline-tools, the Maestro CLI, and `bread-sheet-app/.env`. The earlier conclusion looks like a
sandbox denial recorded as an absence — worth distinguishing, because it changed the verdict.

## Open Questions

None requiring a product decision. Defects 1–4 have a clear fix direction and no ambiguity in the
acceptance criteria. The only judgement call for the implementer:

- **Fix 5 (assertion strength) now or as a follow-up?** Recommended now — it is a two-line change
  per flow, and a flow that can pass vacuously is worse than no flow, since it would report green
  the first time the suite actually runs.

## Why the Earlier Run Passed This (harness lesson, not an implementer task)

Recorded here so the fix lands in the contract rather than in one ticket. Four of the five hold
generally:

1. **The environment-gap clause became a loophole.** The guardrails' Maestro clause says an
   unprovisioned SDK/AVD/Maestro is "an environment prerequisite gap … don't treat it as a code
   failure". That is right for an incidental suite, but here the runner *was* the deliverable, so
   "couldn't run it" was recorded as a footnote under a PASS.
2. **Acceptance criteria were ticked without being executed.** AC 1 asserts runtime behaviour and
   was ticked on inspection.
3. **551 lines of new executable shipped having only ever reached their first `fail()`.** All four
   blocking defects sit past that point.
4. **A denied path was recorded as an absent path**, which is what justified skipping the live run.
5. **Two new tests were written against a mock that freezes the state the code under test
   mutates**, so they passed no matter what the code did.

These are addressed in `agent-team/src/prompts/guardrails.md` (shared by both harnesses) rather
than in this ticket.