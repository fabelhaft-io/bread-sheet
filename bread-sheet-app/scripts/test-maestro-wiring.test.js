/**
 * TICKET-P9-003 — guards for the Maestro native E2E suite.
 *
 * Two jobs:
 *
 *  1. Wiring that must not rot: the reviewer's test matrix runs
 *     `npm --prefix bread-sheet-app run test:maestro` conditionally for
 *     camera/scan tickets, so the npm script, the runner and the flows have to
 *     keep matching each other.
 *  2. Regressions for the defects that made the runner unable to complete a run
 *     (missing `await`, adb calls before the install, AVD discovery through a
 *     tool that isn't installed). Those are unit-tested against the runner's own
 *     exported helpers where the logic is pure, and asserted structurally where
 *     the code needs a real device.
 *
 * No emulator and no Maestro CLI are required — the runner exercises those.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RUNNER_PATH = path.join(ROOT, 'scripts', 'test-maestro.js');
const RUNNER_SRC = fs.readFileSync(RUNNER_PATH, 'utf8');
// Requiring the runner must not execute it — it guards on `require.main`.
const runner = require('./test-maestro.js');

/** A throwaway SDK layout with an `emulator` binary that prints AVD names. */
function fakeSdkWithAvds(names) {
  const sdk = fs.mkdtempSync(path.join(os.tmpdir(), 'p9003-sdk-'));
  fs.mkdirSync(path.join(sdk, 'emulator'), { recursive: true });
  const bin = path.join(sdk, 'emulator', 'emulator');
  fs.writeFileSync(bin, `#!/bin/sh\n${names.map((n) => `echo "${n}"`).join('\n')}\n`);
  fs.chmodSync(bin, 0o755);
  return sdk;
}

describe('Maestro E2E wiring (TICKET-P9-003)', () => {
  test('package.json exposes the test:maestro script the reviewer runs', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['test:maestro']).toBe('node scripts/test-maestro.js');
  });

  test('runner script exists and parses as valid JavaScript', () => {
    expect(fs.existsSync(RUNNER_PATH)).toBe(true);
    // node --check compiles without executing — catches syntax errors that would
    // otherwise only surface when the reviewer runs the script.
    expect(() =>
      execFileSync(process.execPath, ['--check', RUNNER_PATH], { stdio: 'pipe' })
    ).not.toThrow();
  });

  test('every Maestro flow targets the app and asserts it reached the product screen', () => {
    const dir = path.join(ROOT, 'e2e', 'maestro');
    const flows = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
      .sort();
    expect(flows.length).toBeGreaterThanOrEqual(1);

    for (const flow of flows) {
      const yaml = fs.readFileSync(path.join(dir, flow), 'utf8');
      expect(yaml).toContain('appId: com.breadsheetexpo.breadsheet');
      // Landing assertions must be on the product screen's testIDs. Asserting
      // the literal barcode instead is vacuous: it is also the manual sheet's
      // placeholder, so it stays on screen when navigation never happened.
      expect(yaml).toContain('product-(screen|not-found|offline)');
      expect(yaml).not.toMatch(/visible:\s*"4006381333931"/);
      // Every flow starts from a signed-out app: they run in sequence and each
      // signs in as a guest, so a flow that inherits the previous one's session
      // never sees "Continue as Guest".
      expect(yaml).toMatch(/launchApp:\s*\n\s*clearState: true/);
    }

    // The camera flow must actually drive a scan (the dev-only inject deep link).
    const scan = fs.readFileSync(path.join(dir, 'barcode-scan.yaml'), 'utf8');
    expect(scan).toContain('openLink');
    expect(scan).toContain('breadsheet://scan?inject=');
  });
});

describe('runner regressions (TICKET-P9-003)', () => {
  test('AVD discovery finds AVDs without cmdline-tools installed', () => {
    // The maintainer's machine: an SDK with an emulator and an AVD, but no
    // cmdline-tools — so no avdmanager. Discovering AVDs through avdmanager made
    // the runner refuse an AVD that exists, in exactly the case the fallback was
    // written for.
    const sdk = fakeSdkWithAvds(['Medium-Phone-Android-17', 'breadsheet-e2e']);
    expect(fs.existsSync(path.join(sdk, 'cmdline-tools'))).toBe(false);

    expect(runner.listExistingAvds(sdk)).toEqual(
      expect.arrayContaining(['Medium-Phone-Android-17', 'breadsheet-e2e'])
    );
  });

  test('AVD discovery also reads ANDROID_AVD_HOME when the emulator cannot run', () => {
    const avdHome = fs.mkdtempSync(path.join(os.tmpdir(), 'p9003-avd-'));
    fs.writeFileSync(path.join(avdHome, 'From-Disk.ini'), 'path=/nowhere\n');
    const previous = process.env.ANDROID_AVD_HOME;
    process.env.ANDROID_AVD_HOME = avdHome;
    try {
      // An SDK whose emulator binary does not exist at all.
      expect(runner.listExistingAvds(path.join(avdHome, 'no-such-sdk'))).toEqual(['From-Disk']);
    } finally {
      if (previous === undefined) delete process.env.ANDROID_AVD_HOME;
      else process.env.ANDROID_AVD_HOME = previous;
    }
  });

  test('adb device listing skips the header and reports serials', () => {
    const sdk = fs.mkdtempSync(path.join(os.tmpdir(), 'p9003-adb-'));
    fs.mkdirSync(path.join(sdk, 'platform-tools'), { recursive: true });
    const bin = path.join(sdk, 'platform-tools', 'adb');
    fs.writeFileSync(
      bin,
      '#!/bin/sh\nprintf "List of devices attached\\nemulator-5554\\tdevice\\nemulator-5556\\toffline\\n\\n"\n'
    );
    fs.chmodSync(bin, 0o755);

    expect(runner.listDeviceSerials(sdk)).toEqual(['emulator-5554', 'emulator-5556']);
  });

  test('the Gradle build step is awaited', () => {
    // `runStreaming` returns a Promise. Reading `.code` off it without awaiting
    // makes `res.code !== 0` true on every run, so the runner aborted with
    // "exit undefined" while the Gradle child kept going orphaned.
    // Asserted on the source, not on `fn.constructor.name`: babel-jest
    // transpiles async functions away when this module is required.
    expect(RUNNER_SRC).toMatch(/async function buildAndInstallDebug\(/);
    expect(RUNNER_SRC).toMatch(/await buildAndInstallDebug\(/);
    const unawaited = RUNNER_SRC.split('\n').filter(
      (line) => /(?:^|[^.\w])runStreaming\(/.test(line) && !/await runStreaming\(/.test(line)
        && !/^\s*(?:\*|\/\/)/.test(line) && !/function runStreaming/.test(line)
    );
    expect(unawaited).toEqual([]);
  });

  test('app data is wiped and CAMERA granted only after the APK is installed', () => {
    // Before the install the package does not exist, so `pm clear` / `pm grant`
    // fail: no camera pre-grant on a first run, and no wipe on later runs — the
    // previous run's guest session then survives and both flows stall on
    // "Continue as Guest". Verified against a booted emulator: `pm clear` on a
    // package that is not installed exits 1 with "Failed".
    const install = RUNNER_SRC.indexOf('await buildAndInstallDebug(');
    const clear = RUNNER_SRC.indexOf("'pm', 'clear'");
    const grant = RUNNER_SRC.indexOf("'pm', 'grant'");
    expect(install).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(install);
    // `pm clear` revokes runtime permissions, so the grant has to follow it too.
    expect(grant).toBeGreaterThan(clear);
  });

  test('child processes are spawned onto a real file descriptor', () => {
    // `fs.createWriteStream` opens asynchronously, so its `fd` is still null on
    // the next line and `spawn` throws ERR_INVALID_ARG_VALUE for the stdio
    // argument — the runner died the moment it tried to boot the emulator.
    expect(RUNNER_SRC).not.toMatch(/createWriteStream\(/);
    expect(RUNNER_SRC).toMatch(/fs\.openSync\(path\.join\(ARTIFACTS_DIR/);
  });

  test('JDK probing rejects a JDK older than the Gradle build needs', () => {
    expect(runner.javaMajorVersion('openjdk version "21.0.3" 2024-04-16')).toBe(21);
    expect(runner.javaMajorVersion('openjdk version "17" 2021-09-14')).toBe(17);
    expect(runner.javaMajorVersion('java version "1.8.0_401"')).toBe(8);
    expect(runner.javaMajorVersion('no version here')).toBeNull();
    expect(runner.MIN_JAVA_MAJOR).toBe(17);
  });

  test('a failed step throws so the emulator and Metro still get torn down', () => {
    // `process.exit` does not unwind `finally`; every post-boot failure used to
    // orphan a headless emulator and a Metro server holding :8081.
    expect(RUNNER_SRC).toMatch(/function fail\([^)]*\)\s*\{\s*throw new RunnerError/);
    expect(RUNNER_SRC).toMatch(/\}\s*finally\s*\{\s*\n\s*teardown\(/);
  });
});
