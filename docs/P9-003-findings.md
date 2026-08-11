# P9-003 Findings — Android Emulator + Maestro E2E Coverage

**Date:** 2026-08-11 (reviewer run on the resumed BLOCKED cycle, at `33b8bc9`)
**Branch:** `agent/P9-003` (base: `main`) — PR [#110](https://github.com/fabelhaft-io/bread-sheet/pull/110), open
**Ticket:** [TICKET-P9-003] Android Emulator + Maestro E2E Coverage
**Status:** ❌ **BLOCKED** — not on a defect. All five known defects are verifiably fixed; the
deliverable itself has still never been executed, and the two things standing in the way are
outside every agent role's write scope. **This hands back to a human, not to another fix cycle.**

> **Supersedes** the 2026-08-11 BLOCKED doc (4 defects) and, before it, the 2026-08-10 `✅ PASS`.
> The defect list in the previous revision is preserved below under "Defect verification" with
> the evidence that each is now closed.

---

## Current State

The implementer's fix cycle against the previous BLOCKED doc landed as `33b8bc9`, on top of the
original `2df4242`. It fixes the four blocking defects, seven of the eleven non-blocking
findings, and one defect it found by doing what the first review did not: running the runner
past its first prerequisite gate.

The runner now gets much further than it ever has. It resolves every prerequisite on this
machine, accepts the AVD that exists here, boots a real headless emulator, discovers its serial
and tears it down cleanly. That is roughly the first third of `main()`.

**What has still never happened is a completed `npm run test:maestro`.** `expo prebuild`,
`gradlew :app:installDebug`, Metro's own lifecycle inside the runner, `adb reverse` end-to-end,
the `breadsheet://scan?inject=` deep link resolving to the scan tab on a device, and both Maestro
flows are all unexecuted. Acceptance criterion 2 is entirely about that.

## What Was Implemented (this cycle)

All changes stay inside `bread-sheet-app/` plus `docs/architecture/frontend.md`. `server/` is
untouched (`git diff main...HEAD -- server/` is empty).

- **`scripts/test-maestro.js`** (+354/−…): `buildAndInstallDebug` is `async` and awaited;
  `pm clear` / `pm grant` moved after the install and their status checked; AVD discovery moved
  to `emulator -list-avds` + `$ANDROID_AVD_HOME` with `avdmanager` kept for *creation* only;
  child processes spawned onto an `fs.openSync` fd instead of a not-yet-open `WriteStream`;
  `fail()` throws a `RunnerError` so `main`'s `finally` runs teardown; Maestro resolved in the
  prerequisite phase; `curl … | bash` install inverted to opt-in (`MAESTRO_INSTALL=1`); every
  `adb` call pinned with `-s <serial>`; `adb wait-for-device` replaced by a bounded poll; Metro
  killed by process group; JDK probe rejects < 17. New: `MAESTRO_PREREQS_ONLY=1` and a
  `require.main === module` guard exposing the pure helpers for unit tests.
- **`app/(tabs)/scan.tsx`**: the injection seam tracks consumption in a `useRef` and clears its
  timer on unmount only, so the `setParams` re-render no longer cancels the scan it started.
- **`app/(tabs)/scan-screen.test.tsx`**: the `expo-router` mock's `setParams` now really mutates
  the params and notifies subscribers, so the component re-renders exactly as it does in
  production. 7 → 11 tests.
- **`scripts/test-maestro-wiring.test.js`**: 3 → 11 tests (AVD discovery against a fake SDK with
  no cmdline-tools, `adb devices` parsing, JDK version parsing, structural guards for defects 1,
  3 and 5).
- **`e2e/maestro/*.yaml`**: landing assertions moved to `product-(screen|not-found|offline)`
  testIDs; both flows `launchApp` with `clearState: true`.
- **`docs/architecture/frontend.md`**: the "Native E2E" section rewritten to match.

## Defect Verification

Every claim below was re-run by the reviewer, not taken from the implementer's report. Mutations
were applied to a throwaway copy of `bread-sheet-app/` in the scratch directory (`node_modules`
symlinked) — the worktree source was never modified.

| # | Defect | Verification method | Result |
|---|--------|--------------------|--------|
| 1 | `buildAndInstallDebug` not awaited | Mutation: dropped `async`/`await`, re-ran the wiring suite | ✅ `the Gradle build step is awaited` **fails** |
| 2 | Injection seam cancels its own scan | Mutation: restored the `[inject]`-keyed `clearTimeout` cleanup, re-ran `scan-screen.test.tsx` | ✅ **3 of 11 fail** (was 11/11 green) |
| 3 | `pm clear`/`pm grant` before install | Mutation: moved the block back before the install, **leaving `await` intact** so the guard couldn't pass by proxy | ✅ `app data is wiped … only after the APK is installed` **fails**, and only that one |
| 3 | premise of the defect | On a real booted emulator: `pm clear` on a package that isn't installed | ✅ `status 1 | Failed` — the pre-install calls really were no-ops |
| 4 | AVD discovery blind without cmdline-tools | Called the shipped helper against this machine's real SDK | ✅ `listExistingAvds('/home/jano/Android/Sdk')` → `["Medium-Phone-Android-17"]`, with `~/Android/Sdk/cmdline-tools` confirmed absent |
| 5 | `spawn` onto a `WriteStream` with `fd === null` | Booted a **real headless emulator** through the runner's own `bootEmulator`/`waitForBoot`/`teardown` | ✅ `spawn ok, pid 34582` → `device attached: emulator-5554` → `device booted (API 37)` → teardown, **0 orphan processes** |

Defect 2 is the one that matters most for the guardrails' mock rule, and it is genuinely closed:
the router mock now mutates `mockParamsState` and force-renders every subscriber, so the effect
re-runs for real and the cleanup path is actually executed. Reintroducing the production bug
turns 3 tests red. **These tests can fail.**

## Test Results

Everything below was executed on this machine today. Commands are given as run; `not_run` is
recorded where it is the truth.

| Check | Exit | Observed |
|-------|------|----------|
| `npm --prefix server run typecheck` / `test` | not_run | `git diff main...HEAD -- server/` is empty — server pillar untouched |
| `npm --prefix bread-sheet-app run typecheck` | 0 | clean |
| `npm --prefix bread-sheet-app run lint` | 0 | `✖ 1 problem (0 errors, 1 warning)` — the warning is `review-edit/[editId].tsx:149 'approvalsLeft' unused`, pre-existing and outside this diff |
| `npm --prefix bread-sheet-app test` | 0 | **29 suites / 254 tests passed** (was 244; +10 from this cycle) |
| `npm --prefix bread-sheet-app run test:e2e` (Playwright) | 1 | **2 failed** — `auth.spec.ts` and `scan-tab.spec.ts`, both timing out on `getByText('Continue as Guest')`. **Cause is environmental, not this diff:** the worktree has no `bread-sheet-app/.env`, and `lib/supabase.ts:9` throws `Supabase URL and Publishable Key are required.` at import, so the app never renders. Confirmed by `fs.existsSync`: absent in the worktree, present in the main checkout. The same two specs are green in CI on this branch, where the values come from repo variables. |
| `node scripts/test-maestro.js` (bare) | 2 | `ERROR: bread-sheet-app/.env is missing — … (Set MAESTRO_SKIP_ENV_CHECK=1 to bypass.)` — correct, actionable |
| `MAESTRO_SKIP_ENV_CHECK=1 MAESTRO_PREREQS_ONLY=1 node scripts/test-maestro.js` | 2 | `Android SDK: /home/jano/Android/Sdk` → `Java: /opt/android-studio/jbr/bin/java` → `ERROR: Maestro CLI not installed.` Both resolutions are real: the JDK was found with `java` **not** on `PATH` and `JAVA_HOME` unset |
| same + **stub** `maestro` on `PATH`, `MAESTRO_AVD=Medium-Phone-Android-17` | 0 | `using existing AVD "Medium-Phone-Android-17"` → `prerequisites OK`. **The `maestro` on that line is a shell stub I created, not the CLI** — this run proves the AVD gate, nothing about Maestro |
| same, `MAESTRO_AVD=no-such-avd` | 2 | `MAESTRO_AVD="no-such-avd" does not exist. AVDs found: Medium-Phone-Android-17.` |
| same, no `MAESTRO_AVD` (default `breadsheet-e2e`) | 0 | falls back with the documented warning to `Medium-Phone-Android-17` — the no-cmdline-tools path works end to end |
| Real emulator boot + teardown via the runner's helpers | 0 | see defect 5 above; `pgrep qemu` empty afterwards |
| `expo start` + `curl localhost:8099/status` | 0 | `packager-status:running` — `waitForMetro`'s string contract is correct |
| GitHub CI on PR #110 at `7f78dea` | 0 | **all 6 checks pass** — App unit, **App E2E (Playwright, Expo web)**, Server unit & integration, CodeQL, both Analyze jobs. Note this is the **first** CI run that includes the fix commit `33b8bc9`: the previously reported green was on `07eeb5a`, before it. The Playwright job passing here — with `EXPO_PUBLIC_SUPABASE_*` supplied as repo variables — is the direct confirmation that the two local failures above are the missing `.env` and not a regression from this diff |
| **`npm run test:maestro` to completion** | **not_run** | **Never executed by anyone. This is the blocker.** |

**Environment, verified directly (not inferred from a failure):**

- Android SDK **present** at `/home/jano/Android/Sdk` (`emulator/`, `platform-tools/`,
  `platforms/`, `build-tools/`, `system-images/android-37.1`, `licenses/`).
- `~/Android/Sdk/cmdline-tools` → `No such file or directory`; no `avdmanager`/`sdkmanager`.
- AVD `Medium-Phone-Android-17` exists and boots (API 37).
- JDK at `/opt/android-studio/jbr/bin/java`; `java` not on `PATH`, `JAVA_HOME` unset.
- Maestro CLI **absent**: `command -v maestro` → empty, `ls ~/.maestro` → `No such file or directory`.
- `bread-sheet-app/.env` **absent** in this worktree (present in the main checkout).
- `/dev/kvm` present and world-writable; no pre-existing emulator.

## Acceptance Criteria Tracking

- [ ] **Android emulator runs locally (or in CI) without manual per-run setup.**
  *Partially demonstrated, not met.* The emulator half is now real: on this machine the runner
  resolves SDK/JDK/AVD with no manual setup and boots a headless emulator to `sys.boot_completed`
  unattended, verified above. But "runs without manual per-run setup" is a claim about the whole
  command, and the command has never completed. There is also a per-machine one-off that is not
  per-*run* but is worth naming: with no cmdline-tools the runner cannot create its own AVD and
  silently borrows whichever AVD it finds first.
- [ ] **At least one Maestro flow exercises barcode scanning end-to-end against a debug build.**
  **Not met, and this is the whole of the blockage.** Neither flow has ever been executed. The
  jest suite proves the *seam* routes correctly in a JS test renderer; it proves nothing about the
  debug build, the deep link, or Maestro. Per the guardrails' "Execute, don't infer", this
  criterion cannot be ticked.
- [ ] **The reviewer's already-wired conditional step actually runs.**
  *Met in the static sense; ticked only when the ticket as a whole is.* This one is legitimately
  satisfiable statically and the guardrails allow saying so: `package.json` exposes
  `"test:maestro": "node scripts/test-maestro.js"`, the reviewer's conditional step fired in this
  very run, and the script executed and produced a real, distinct exit code (2, with an actionable
  message) rather than "command not found". What it has never produced is a pass/fail signal about
  the scan flow.

## Why This Is BLOCKED Rather Than a Pass

Guardrails, "Verification": *"An environment gap on the ticket's own deliverable is `BLOCKED` …
When in doubt: if fixing the environment could change the verdict, the verdict is `BLOCKED`."*
That is exactly this case. The environment gap is not on some incidental neighbouring suite — the
Maestro runner **is** the deliverable, and provisioning `.env` + the Maestro CLI could very
plausibly change the verdict, because a first real run is where the remaining unknowns below get
answered.

Three concrete unknowns that only a real run resolves, none of which I have any evidence against
— they are listed as things to watch, not as defects:

1. **`expo start` vs a bare debug build.** The runner does `expo prebuild` + `gradlew
   :app:installDebug` + `expo start`, rather than `expo run:android` (the app's own `android`
   script). `expo-dev-client` is not a dependency, so `expo start` comes up in Expo Go mode; the
   installed debug APK still fetches `index.bundle` from the same Metro over `adb reverse`, and
   that normally works, but nobody has watched it.
2. **The deep link.** `openLink: "breadsheet://scan?inject=…"` must resolve through the generated
   Android intent filter to `app/(tabs)/scan.tsx` *with the param attached* and past the auth
   gate. `app.json` has `"scheme": "breadsheet"`, so the filter will exist after prebuild; that
   the route and the param survive the trip is unverified.
3. **Maestro's selectors on a React Native hierarchy.** The regex ids
   (`.*product-(screen|not-found|offline).*`) and the two `assertNotVisible` steps are written
   against testIDs that all exist in the source (verified by grep: `home-screen`,
   `product-screen`, `product-not-found`, `product-offline`, `scan-manual-entry`, `scan-torch`,
   `manual-barcode-input`, `manual-barcode-submit`, and the literal `Continue as Guest` in
   `app/(auth)/login.tsx:97`), but no one has confirmed how they surface to Maestro — in
   particular whether the scan tab's `scan-torch` really leaves the hierarchy once the product
   screen is pushed on top of it inside a tab navigator.

**This does not go back to the implementer.** The two blockers are things no agent role may do:
creating `bread-sheet-app/.env` is forbidden outright by the guardrails' Scope rule ("Never edit
… any `.env` file … regardless of role"), and installing the Maestro CLI means running
`curl … | bash` on the maintainer's machine, which I declined to do unprompted. A third fix cycle
would produce more static hardening against the same unexecuted code, which is the failure mode
this ticket already demonstrated twice.

## What a Human Needs To Do (one sitting, ~1 hour mostly unattended)

1. `cp bread-sheet-app/.env` from the main checkout into the worktree (or fill it from
   `.env.example`) — `EXPO_PUBLIC_SUPABASE_URL` + `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`.
2. `curl -Ls "https://get.maestro.mobile.dev" | bash` (or `MAESTRO_INSTALL=1`).
3. `MAESTRO_PREREQS_ONLY=1 npm --prefix bread-sheet-app run test:maestro` — should print
   `prerequisites OK` and exit 0 in about a second. (This is the check the new env var exists for.)
4. `npm --prefix bread-sheet-app run test:maestro` — budget 10–40 min and ~1 GB for the first
   Gradle run. Watch it; do not leave it to a `nohup`.
5. Paste the outcome into this doc. If both flows pass, the boxes in `FEATURES.md:1386` can be
   ticked and #110 merged. If they don't, the failures go to the implementer as a bounded cycle.

Optional but recommended before the merge: `sdkmanager "cmdline-tools;latest"`, which makes the
runner able to create its own `breadsheet-e2e` AVD instead of borrowing an arbitrary one.

## Judgement Calls Assessed

**`MAESTRO_PREREQS_ONLY=1` — in scope.** Six lines plus documentation. It is the direct answer to
old finding 7 (don't discover a missing prerequisite 40 minutes into a build), it is what made
every AVD-gate verification in this review possible on an unprovisioned machine, and it is
step 3 of the human runbook above. Accepted. One wart worth a comment in the source: it is now
the only `process.exit` left inside `main()`, i.e. the pattern old finding 6 removed. It is safe
*today* only because it sits above `bootEmulator` and there is nothing yet to tear down. If that
call ever moves below the boot, it orphans an emulator.

**`require.main === module` guard — in scope, and required.** The previous doc asked for the
defects to be covered by tests rather than mocked away; the helpers that carried defects 1, 4
and 5 live in a script whose top level boots an emulator. Without the guard they are untestable.
The `module.exports` block is confined to the `else` branch, so the executable path is unchanged.
Accepted without reservation.

## Non-Blocking Findings

Carried forward, renumbered, with this cycle's status.

1. ~~Defect 1 (missing `await`)~~ — **fixed**, verified by mutation.
2. ~~Defect 2 (self-cancelling seam)~~ — **fixed**, verified by mutation.
3. ~~Defect 3 (`pm clear` before install)~~ — **fixed**, verified by mutation + on-device.
4. ~~Defect 4 (AVD discovery)~~ — **fixed**, verified against the real SDK.
5. ~~Weak flow assertions~~ — **fixed**; both flows land on `product-*` testIDs and a jest guard
   forbids `visible: "4006381333931"`.
6. ~~`fail()` bypasses teardown~~ / 7. ~~Maestro resolved after the build~~ /
   8. ~~`curl | bash` by default~~ / 9. ~~unpinned adb, unbounded `wait-for-device`~~ /
   10. ~~Metro killed by pid not process group~~ / 13. ~~JDK version unchecked~~ — **all fixed.**
   Of these, only 7, 9 (the `-s` pinning) and 13 were observed executing; 6 and 10 are covered by
   structural guards and one real teardown that left no orphan.
11. **The emulator still boots before the 10–40 minute Gradle build.** Unchanged, and it is now
    the runner's biggest idle-burn. Deliberately left, presumably because `installDebug` wants a
    device. Splitting `assembleDebug` (no device) from `installDebug` would let the boot start
    after the build. Follow-up.
12. **`expo prebuild` still runs only when `android/` is absent**, so a stale native project
    survives an `app.json` change. Unchanged. Follow-up.
14. **Doc rot — partly fixed by this review, partly outstanding.**
    - `docs/architecture/agent-dev-team.md` — **fixed in this commit** by the reviewer (in scope:
      it is under `docs/`). Its "Not done" bullet and the P9-003 lesson section now describe the
      real state.
    - `CLAUDE.md`'s frontend command list still lacks `test:maestro`. **Human task** — `CLAUDE.md`
      is outside every agent role's write scope.
    - **New:** `bread-sheet-app/playwright.config.ts:4-6`'s docblock still says "no Android SDK on
      this machine yet; Maestro/Android is a documented follow-up, not built". That is now false
      and it sits in the frontend pillar. Implementer/human task.
15. **No CI job.** Unchanged and still a human/coordinator task (`.github/workflows/*` is outside
    every pillar). This is the finding with the most leverage: `reactivecircus/android-emulator-runner`
    would mean the flows run on every PR, which is the only durable answer to "the suite was never
    executed" — the failure mode this ticket has now hit twice.
16. **New: the 775-line runner is never linted.** `npm run lint` resolves to
    `eslint app components`, so nothing under `scripts/` is checked. Worth widening, or at least
    knowing.
17. **New: the wiring guards are source-text greps, not behavioural tests.** They do fail on
    reintroduction — I proved that for all three — but they assert on `RUNNER_SRC` strings, so a
    semantically equivalent regression can slip past (assigning `runStreaming(...)` to a variable
    across two lines evades the un-awaited scan). One is also coupled to another: the
    "wiped after install" guard keys off the literal `'await buildAndInstallDebug('`, so removing
    the `await` fails *both* guards and the ordering guard's independence is only apparent when
    the two mutations are applied separately (which is why I did). Acceptable as rot-guards;
    they should not be read as coverage of the runner's behaviour.
18. **New: PR #110's description is stale and misleading.** Its body still carries the original
    run's "Test results" table asserting a pass. A commit cannot rewrite a PR description —
    **a human must edit it** before this PR is read by anyone as a summary of the branch.

## Open Questions

No product decisions outstanding. Two process questions for the human:

1. **Does P9-003 merge on a single green local run, or does it need the CI job (finding 15)
   first?** A local-only suite satisfies the ticket as written, but a suite that runs only when
   someone remembers to run it is how this branch reached a green PR twice with a runner that
   could not run. My recommendation: merge on a green local run, and open the CI job as its own
   ticket immediately rather than folding it in here.
2. **Should the runner keep silently borrowing an arbitrary AVD when cmdline-tools are missing?**
   Today it warns and takes `existing[0]`, which on this machine happens to be a correct choice.
   On a machine with a Wear OS or API-24 AVD first in the list it would boot something the app
   cannot install on, and the failure would look like a build failure. A stricter option: require
   `MAESTRO_AVD` when it cannot create its own. Not blocking; needs a call.
