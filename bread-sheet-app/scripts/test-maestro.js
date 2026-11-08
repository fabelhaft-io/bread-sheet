#!/usr/bin/env node
'use strict';

/**
 * TICKET-P9-003 — self-provisioning Maestro E2E runner for the native
 * camera/scan flows (`e2e/maestro/*.yaml`).
 *
 * The reviewer's test matrix runs `npm --prefix bread-sheet-app run test:maestro`
 * conditionally for tickets whose diff touches camera/scan code, so this script
 * must be a single, repeatable command: it resolves every prerequisite (Android
 * SDK, JDK, AVD, Maestro CLI), boots a headless emulator, builds + installs the
 * debug APK, starts Metro, runs the Maestro flows, and tears everything down —
 * no per-run manual setup. Each prerequisite failure exits with a distinct,
 * actionable message (exit code 2) instead of a confusing downstream crash.
 *
 * Environment overrides (all optional):
 *   ANDROID_HOME / ANDROID_SDK_ROOT   where the SDK lives (else probed)
 *   JAVA_HOME                         JDK 17+ for the Gradle build (else probed)
 *   MAESTRO_AVD                       AVD name to use/create (default breadsheet-e2e)
 *   MAESTRO_SYSTEM_IMAGE              system image to install if none present
 *   MAESTRO_INSTALL=1                 opt IN to auto-installing the Maestro CLI
 *                                     (`curl … | bash`); off by default
 *   MAESTRO_METRO_PORT                Metro port (default 8081)
 *   MAESTRO_FLOW                      run a single flow file instead of e2e/maestro
 *   MAESTRO_SKIP_ENV_CHECK=1          don't require bread-sheet-app/.env
 *   MAESTRO_PREREQS_ONLY=1            resolve prerequisites, then exit 0 without
 *                                     booting/building (a fast machine check)
 *   MAESTRO_APK=<path>                install this prebuilt debug APK instead of
 *                                     running prebuild + Gradle (a missing file, or
 *                                     one without the AVD's ABI, is a hard error)
 *   MAESTRO_APK_OUT=<path>            copy the APK here after a successful build
 *                                     (CI caches it under a native fingerprint)
 *   MAESTRO_GRADLE_TIMEOUT_MS / MAESTRO_BOOT_TIMEOUT_MS / MAESTRO_METRO_TIMEOUT_MS
 *
 * Prerequisites for a full run: JDK 17+, an Android SDK with emulator +
 * platform-tools + a system image (cmdline-tools for AVD creation), network
 * access for Maestro's install script and Gradle's first build, and a reachable
 * Supabase project via `bread-sheet-app/.env` (guest sign-in + product lookup —
 * the same prerequisite the Playwright specs document). On a machine without
 * those, the script reports exactly which one is missing and how to fix it.
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APP_ID = 'com.breadsheetexpo.breadsheet';
const DEFAULT_AVD = 'breadsheet-e2e';
const PREFERRED_SYSTEM_IMAGE =
  process.env.MAESTRO_SYSTEM_IMAGE || 'system-images;android-35;google_apis;x86_64';
const METRO_PORT = process.env.MAESTRO_METRO_PORT || '8081';
const METRO_STATUS_URL = `http://localhost:${METRO_PORT}/status`;
const BOOT_TIMEOUT_MS = Number(process.env.MAESTRO_BOOT_TIMEOUT_MS || 5 * 60 * 1000);
const METRO_TIMEOUT_MS = Number(process.env.MAESTRO_METRO_TIMEOUT_MS || 2 * 60 * 1000);
const GRADLE_TIMEOUT_MS = Number(process.env.MAESTRO_GRADLE_TIMEOUT_MS || 40 * 60 * 1000);

const AVD_NAME = process.env.MAESTRO_AVD || DEFAULT_AVD;
/**
 * Where AVDs live, pinned for every tool that touches them. Read per call, not captured at
 * import, so ANDROID_AVD_HOME stays a live override.
 *
 * `avdmanager` and `emulator` do NOT agree on where to look by default: avdmanager writes to
 * $ANDROID_SDK_HOME/.android/avd while the emulator searches $ANDROID_SDK_HOME/avd, so on any
 * machine with ANDROID_SDK_HOME set (GitHub's hosted runners among them) creation reports
 * success and the boot then fails with "Unknown AVD name". Both consult ANDROID_AVD_HOME
 * first, so setting it explicitly makes them agree.
 */
function avdHome() {
  return process.env.ANDROID_AVD_HOME || path.join(os.homedir(), '.android', 'avd');
}
const FLOWS_DIR = path.join(ROOT, 'e2e', 'maestro');
const ARTIFACTS_DIR = path.join(FLOWS_DIR, 'artifacts');
const ENV_FILE = path.join(ROOT, '.env');
const ANDROID_DIR = path.join(ROOT, 'android');
const DEBUG_APK = path.join(ANDROID_DIR, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
// Records the app.json/package.json fingerprint android/ was generated from. Lives inside
// android/, which is gitignored, so it is regenerated with the project it describes.
const PREBUILD_STAMP = path.join(ANDROID_DIR, '.breadsheet-prebuild');

function log(...args) {
  console.log('[test:maestro]', ...args);
}

function warn(...args) {
  console.warn('[test:maestro] WARN:', ...args);
}

/**
 * A prerequisite/step failure. Thrown rather than `process.exit`ed: exiting from
 * deep inside the run skips `main`'s `finally`, which is what tears down the
 * headless emulator and Metro — a failed run must not leave either orphaned.
 */
class RunnerError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.name = 'RunnerError';
    this.code = code;
  }
}

function fail(message, code = 2) {
  throw new RunnerError(message, code);
}

/** Blocking sleep without spawning a child process. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Run a short-lived command to completion, returning { status, stdout, stderr }. */
function runSync(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    env: { ...process.env, ...opts.env },
    cwd: opts.cwd || ROOT,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  return {
    status: res.status,
    stdout: (res.stdout || '').trim(),
    // `java -version` writes to stderr on every JDK ≤ 8 and most later ones.
    stderr: (res.stderr || '').trim(),
  };
}

/** Run a long-lived command, streaming output, resolving { code, signal }. */
function runStreaming(cmd, args, { cwd = ROOT, env = {}, timeoutMs = Infinity } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const timer =
      timeoutMs === Infinity
        ? null
        : setTimeout(() => {
            log(`timed out after ${timeoutMs}ms, killing ${cmd}`);
            child.kill('SIGKILL');
          }, timeoutMs);
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal });
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      log(`failed to spawn ${cmd}: ${err.message}`);
      resolve({ code: 127, signal: null });
    });
  });
}

function httpGet(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

// ─── Prerequisite resolution ─────────────────────────────────────────────────

/** Cores this process may actually use — cgroup-aware where Node exposes it. */
function cpuCount() {
  return typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
}

/**
 * Whether to run the Gradle build concurrently with the emulator boot.
 *
 * Four is the smallest count where a cold React Native build reliably leaves enough CPU for
 * an emulator to reach `sys.boot_completed`. `MAESTRO_OVERLAP_BUILD` forces the decision
 * either way (`1`/`0`) for a machine that disagrees with the heuristic.
 */
function canOverlapBuildAndBoot() {
  const forced = process.env.MAESTRO_OVERLAP_BUILD;
  if (forced === '1') return true;
  if (forced === '0') return false;
  return cpuCount() >= 4;
}

function resolveAndroidSdk() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), 'Android', 'Sdk'),
    '/usr/local/lib/android/sdk', // GitHub-hosted runners
    '/usr/local/android-sdk',
    '/opt/android-sdk',
    '/opt/android/sdk',
  ].filter(Boolean);

  // A *partial* SDK is the common case and used to report identically to no SDK at all:
  // GitHub's ubuntu-24.04 image ships platform-tools but no emulator, so "Android SDK not
  // found" pointed at a directory that plainly existed. Name the missing component instead.
  const partial = [];
  for (const sdk of candidates) {
    const haveEmulator = fs.existsSync(path.join(sdk, 'emulator', 'emulator'));
    const haveAdb = fs.existsSync(path.join(sdk, 'platform-tools', 'adb'));
    if (haveEmulator && haveAdb) return sdk;
    if (haveEmulator || haveAdb) {
      const missing = haveAdb ? 'emulator' : 'platform-tools';
      const present = haveAdb ? 'platform-tools' : 'emulator';
      partial.push(`${sdk} (has ${present}, missing ${missing})`);
    }
  }
  fail(
    partial.length
      ? `Android SDK is incomplete: ${partial.join('; ')}. Install the missing package with ` +
          '`sdkmanager "emulator" "platform-tools"` — CI images commonly ship the SDK and ' +
          'platform-tools without the emulator.'
      : 'Android SDK not found. Set ANDROID_HOME (needs emulator/ and platform-tools/, ' +
          'e.g. ~/Android/Sdk from Android Studio). Install with ' +
          '`sdkmanager "emulator" "platform-tools" "system-images;android-35;google_apis;x86_64"` ' +
          'or via Android Studio → SDK Manager.'
  );
}

const MIN_JAVA_MAJOR = 17;
// Upper bound, and it is not optional. Measured on this project (Gradle 9.3.1, RN 0.86):
//   JDK 26 → 5 failures. AGP's JdkImageTransform runs the JDK's own `jlink` and fails on
//            every library module ("Execution failed for JdkImageTransform …
//            core-for-system-modules.jar"), plus both CMake configure tasks.
//   JDK 25 → 2 failures. jlink is fine; `:react-native-*:configureCMakeDebug` still dies on
//            "a restricted method in java.lang.System has been called" — the JDK 24+
//            native-access restriction.
//   JDK 21 → the newest AGP officially supports, and below the native-access change.
// A floor-only check waves all of that through: JDK 26 passed `>= 17` happily and then burnt
// 10m35s on a build that could not succeed, with five errors none of which were about the app.
const MAX_JAVA_MAJOR = Number(process.env.MAESTRO_MAX_JAVA || 21);

/** Major version from `java -version` output, or null if unparseable. */
function javaMajorVersion(output) {
  // openjdk version "21.0.3" / java version "1.8.0_401" / openjdk version "17"
  const match = /version "(\d+)(?:\.(\d+))?/.exec(output);
  if (!match) return null;
  const first = Number(match[1]);
  // 1.8.0_401 → major 8; anything from 9 on puts the major first.
  return first === 1 ? Number(match[2] || 0) : first;
}

/** Whether a JDK major version is one the Android Gradle Plugin can actually build with. */
function isUsableJavaMajor(major) {
  return Number.isInteger(major) && major >= MIN_JAVA_MAJOR && major <= MAX_JAVA_MAJOR;
}

/**
 * Every `java` under the distro's JVM directory, newest-looking last so the probe order
 * stays stable. Needed because a rolling-release distro commonly has several JDKs installed
 * with `default` pointing at the newest — which is exactly the one AGP cannot use. Without
 * this, an in-range JDK sitting right there in /usr/lib/jvm is invisible and the run dies
 * telling the user to install a JDK they already have.
 */
function systemJavaCandidates(roots = ['/usr/lib/jvm', '/usr/lib64/jvm', path.join(os.homedir(), '.jdks')]) {
  const found = [];
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue; // root absent — normal on macOS and minimal images
    }
    for (const entry of entries.sort()) {
      const java = path.join(root, entry, 'bin', 'java');
      if (fs.existsSync(java)) found.push(java);
    }
  }
  return found;
}

function resolveJava() {
  const candidates = [
    process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, 'bin', 'java'),
    'java', // relies on PATH
    ...systemJavaCandidates(),
    '/opt/android-studio/jbr/bin/java',
    path.join(os.homedir(), 'android-studio', 'jbr', 'bin', 'java'),
    '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java',
  ].filter(Boolean);

  const rejected = [];
  for (const java of candidates) {
    try {
      const res = runSync(java, ['-version']);
      if (res.status !== 0) continue;
      // A JDK that runs but is too old fails 30 minutes later inside Gradle with
      // an unrelated-looking error; reject it here and keep probing instead.
      const major = javaMajorVersion(`${res.stderr}\n${res.stdout}`);
      if (major !== null && !isUsableJavaMajor(major)) {
        rejected.push(`${java} (Java ${major} — ${major < MIN_JAVA_MAJOR ? 'too old' : 'too new'})`);
        continue;
      }
      return java;
    } catch {
      // keep probing
    }
  }
  fail(
    `No JDK between ${MIN_JAVA_MAJOR} and ${MAX_JAVA_MAJOR} found — the Android Gradle Plugin ` +
      'needs one in that range to build the debug APK. ' +
      (rejected.length ? `Rejected: ${rejected.join(', ')}. ` : '') +
      `Install one (e.g. \`pacman -S jdk21-openjdk\` / \`apt install openjdk-21-jdk\`) and point ` +
      'JAVA_HOME at it. Note a rolling-release distro and recent Android Studio may both ship a ' +
      'JDK too new for AGP, so "a JDK is installed" is not the same as "a usable JDK". Override ' +
      'the ceiling with MAESTRO_MAX_JAVA if your AGP supports a newer one.'
  );
}

function resolveMaestro() {
  const envMaestro = path.join(os.homedir(), '.maestro', 'bin', 'maestro');
  const onPath = (() => {
    try {
      return runSync('maestro', ['--version']).status === 0;
    } catch {
      return false;
    }
  })();

  if (onPath) return 'maestro';
  if (fs.existsSync(envMaestro)) return envMaestro;

  // Opt-IN, not opt-out: piping a remote script into bash is a supply-chain
  // surface, and this repo's convention is to fail fast and tell the user what
  // to run rather than to silently do it for them.
  if (process.env.MAESTRO_INSTALL !== '1') {
    fail(
      'Maestro CLI not installed. Install it with ' +
        '`curl -Ls "https://get.maestro.mobile.dev" | bash` (adds ~/.maestro/bin to PATH) ' +
        'then re-run. Set MAESTRO_INSTALL=1 to let this script run that installer for you.'
    );
  }
  log('Maestro CLI not found — MAESTRO_INSTALL=1, installing to ~/.maestro…');
  const res = runSync('bash', ['-c', 'curl -Ls "https://get.maestro.mobile.dev" | bash']);
  if (res.status !== 0 || !fs.existsSync(envMaestro)) {
    fail(
      'Maestro CLI install failed (network?). Install manually with ' +
        '`curl -Ls "https://get.maestro.mobile.dev" | bash` then re-run.'
    );
  }
  return envMaestro;
}

/**
 * The two values the flows need: they sign in as a guest and look up a product, so
 * the app must reach a Supabase project — the same prerequisite as `npm run test:e2e`.
 */
const REQUIRED_APP_ENV = ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY'];

/**
 * Accepts the credentials from the **process environment** or from `bread-sheet-app/.env`,
 * in that order.
 *
 * The environment route exists so a machine that runs the agentic dev team never has to
 * park a credentials file inside a worktree agents can read. These two particular values
 * are config rather than secrets — `EXPO_PUBLIC_*` is inlined into the client bundle, which
 * is why CI passes them as repo *variables* and not secrets (.github/workflows/test.yml) —
 * but the habit is what matters: the same worktree pattern applied to `server/.env` would be
 * handing over GEMINI_API_KEY and DATABASE_URL. Metro inherits this process's environment
 * (startMetro spawns without an `env` override), so exported vars reach the bundler with no
 * further plumbing.
 *
 * Half-configured is an error rather than a silent mix: with one var exported and the other
 * only in `.env`, the app still boots and the failure surfaces much later as an unexplained
 * auth error inside a flow.
 */
function ensureAppCredentials() {
  if (process.env.MAESTRO_SKIP_ENV_CHECK === '1') return;

  const fromEnv = REQUIRED_APP_ENV.filter((key) => (process.env[key] || '').trim() !== '');

  if (fromEnv.length === REQUIRED_APP_ENV.length) {
    log('Supabase credentials: from the process environment (no .env file needed)');
    return;
  }
  if (fromEnv.length > 0) {
    const missing = REQUIRED_APP_ENV.filter((key) => !fromEnv.includes(key));
    fail(
      `Only part of the Supabase config is exported: ${fromEnv.join(', ')} set, ` +
        `${missing.join(', ')} missing. Export both or neither — a half-set environment ` +
        'silently mixes with bread-sheet-app/.env and fails later, inside a flow.'
    );
  }

  if (!fs.existsSync(ENV_FILE)) {
    fail(
      'No Supabase config. The flows sign in as guest and look up a product, so they need a ' +
        'reachable Supabase project (same prerequisite as `npm run test:e2e`). Either export\n' +
        `  ${REQUIRED_APP_ENV.join(' and ')}\n` +
        'in your shell (preferred — nothing is written into the worktree), or copy ' +
        'bread-sheet-app/.env.example → .env and fill them in. ' +
        '(Set MAESTRO_SKIP_ENV_CHECK=1 to bypass.)'
    );
  }

  const contents = fs.readFileSync(ENV_FILE, 'utf8');
  for (const key of REQUIRED_APP_ENV) {
    if (!new RegExp(`^${key}=`, 'm').test(contents)) {
      fail(
        `${key} is missing from bread-sheet-app/.env and is not exported — guest sign-in and ` +
          'product lookup need it (same prerequisite as `npm run test:e2e`).'
      );
    }
  }
  log('Supabase credentials: from bread-sheet-app/.env');
}

// ─── AVD provisioning (acceptance criteria: no per-run manual setup) ──────────

function findAvdmanager(sdk) {
  const candidates = [
    path.join(sdk, 'cmdline-tools', 'latest', 'bin', 'avdmanager'),
    path.join(sdk, 'cmdline-tools', 'bin', 'avdmanager'),
    ...(fs.existsSync(path.join(sdk, 'cmdline-tools'))
      ? fs.readdirSync(path.join(sdk, 'cmdline-tools')).map((v) =>
          path.join(sdk, 'cmdline-tools', v, 'bin', 'avdmanager')
        )
      : []),
    path.join(sdk, 'tools', 'bin', 'avdmanager'),
  ];
  return candidates.find((c) => fs.existsSync(c));
}

function findSdkmanager(sdk) {
  const candidates = [
    path.join(sdk, 'cmdline-tools', 'latest', 'bin', 'sdkmanager'),
    ...(fs.existsSync(path.join(sdk, 'cmdline-tools'))
      ? fs.readdirSync(path.join(sdk, 'cmdline-tools')).map((v) =>
          path.join(sdk, 'cmdline-tools', v, 'bin', 'sdkmanager')
        )
      : []),
    path.join(sdk, 'tools', 'bin', 'sdkmanager'),
  ];
  return candidates.find((c) => fs.existsSync(c));
}

/** Installed x86_64 google_apis system images, newest API first. */
/**
 * Flavours we will boot, and the ones we refuse.
 *
 * Play-Store images are excluded deliberately, not overlooked: on
 * `android-37.1;google_apis_playstore_ps16k` Maestro's `inputText` hangs indefinitely —
 * measured at a 2m59s timeout with no error, while the identical flow passes in seconds on
 * `android-35;google_apis`. Play images are locked down in ways that break the IME
 * manipulation text entry depends on, so an emulator built from one cannot run this suite.
 *
 * This pairs with the API-directory match below: the two must be changed together. Widening
 * the match to accept a dotted API (`android-37.1`) *without* this exclusion would make a
 * Play-Store image selectable and walk straight back into that hang.
 */
const USABLE_IMAGE_FLAVORS = ['google_apis', 'default'];
const REJECTED_IMAGE_FLAVOR = /playstore/;

/** Installed x86_64 system images this suite can actually use, newest API first. */
function installedSystemImages(sdk) {
  const root = path.join(sdk, 'system-images');
  if (!fs.existsSync(root)) return [];
  const found = [];
  for (const apiDir of fs.readdirSync(root)) {
    // `android-35`, and also `android-37.1` — a dotted API directory is real (the
    // extension-level images use it) and the previous `\d+`-only match skipped it silently.
    const match = /^android-(\d+)(?:\.(\d+))?$/.exec(apiDir);
    if (!match) continue;
    const api = Number(match[1]) + (match[2] ? Number(match[2]) / 100 : 0);
    let flavors;
    try {
      flavors = fs.readdirSync(path.join(root, apiDir));
    } catch {
      continue;
    }
    for (const flavor of flavors) {
      if (REJECTED_IMAGE_FLAVOR.test(flavor)) continue;
      // Match `google_apis` and `google_apis_ps16k` alike, but never a *_playstore_* one.
      if (!USABLE_IMAGE_FLAVORS.some((usable) => flavor === usable || flavor.startsWith(`${usable}_`))) {
        continue;
      }
      if (fs.existsSync(path.join(root, apiDir, flavor, 'x86_64'))) {
        found.push({ api, image: `system-images;${apiDir};${flavor};x86_64` });
      }
    }
  }
  found.sort((a, b) => b.api - a.api);
  return found;
}

/**
 * Names of the AVDs on this machine.
 *
 * Discovery goes through `emulator -list-avds`, NOT `avdmanager list avd`:
 * `emulator` ships in every SDK that can boot anything, needs no cmdline-tools
 * and no JDK, whereas `avdmanager` is a cmdline-tools component that plenty of
 * Android Studio installs simply don't have. Reading the AVD list through the
 * tool that might be missing is what made this script refuse AVDs that exist.
 * `avdmanager` is still used, but only to *create* one.
 */
function listExistingAvds(sdk) {
  const names = new Set();
  try {
    const { status, stdout } = runSync(path.join(sdk, 'emulator', 'emulator'), ['-list-avds'], {
      env: { ANDROID_AVD_HOME: avdHome() },
    });
    if (status === 0) {
      for (const line of stdout.split('\n')) {
        const name = line.trim();
        // The emulator prints occasional notices ("INFO |…") on the same stream.
        if (name && !name.includes(' ') && !name.startsWith('INFO')) names.add(name);
      }
    }
  } catch {
    // fall through to the on-disk scan
  }

  // Secondary source: the AVD home directory. Covers an emulator binary that
  // refuses to run (e.g. missing KVM permissions) but a perfectly listable AVD.
  try {
    for (const entry of fs.readdirSync(avdHome())) {
      if (entry.endsWith('.ini')) names.add(entry.slice(0, -'.ini'.length));
    }
  } catch {
    // no AVD home — nothing to add
  }

  return [...names];
}

/**
 * The CPU ABI of an AVD, read from its own config.
 *
 * React Native builds every ABI in gradle.properties' reactNativeArchitectures by default
 * (armeabi-v7a, arm64-v8a, x86, x86_64) — four CMake/NDK compilations of every native module,
 * of which an emulator can execute exactly one. Building only the ABI we are about to boot is
 * the single biggest saving available here: a cold CI build measured 16m46s with all four.
 *
 * Derived, never assumed. ensureAvd() falls back to whatever AVD exists when its preferred one
 * is absent, so on an ARM host that is arm64-v8a; hardcoding x86_64 would produce an APK with
 * no usable native libraries, which installs happily and then crashes on launch. When the ABI
 * cannot be read we build all of them: slow and correct beats fast and broken.
 */
/** ABIs Gradle accepts in reactNativeArchitectures, and the only values avdAbi may return. */
const KNOWN_ABIS = ['x86_64', 'x86', 'arm64-v8a', 'armeabi-v7a'];

/**
 * An Android .ini file as key → value, or null when there is no readable file.
 *
 * Split on the first `=` rather than matched with a `^key=(.+)$` pattern per key, because the
 * two writers that touch these files disagree on spacing: `avdmanager` writes `abi.type=x86_64`
 * when it creates the AVD, while the emulator's own INI writer pads it — `hw.cpu.arch = x86_64`,
 * as any booted AVD's hardware-qemu.ini shows. An unpadded pattern reads the freshly created
 * config and silently misses a rewritten one, which is what made the cache-restored AVD on CI
 * report no ABI at all and fall back to building every architecture. Trimming both halves
 * accepts either spelling, and drops a trailing \r for free.
 */
function readIni(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const values = new Map();
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    // First writing wins: these files are appended to, never rewritten in place.
    if (key && !key.startsWith('#') && !values.has(key)) values.set(key, line.slice(eq + 1).trim());
  }
  return values;
}

/** `hw.cpu.arch` is coarser than Gradle's spelling ("arm64", not "arm64-v8a"). */
const CPU_ARCH_TO_ABI = { x86_64: 'x86_64', x86: 'x86', arm64: 'arm64-v8a', arm: 'armeabi-v7a' };

/**
 * Where an AVD records its ABI, most precise first.
 *
 * `abi.type` is the obvious key and cannot be relied on alone. `image.sysdir.1` is the better
 * fallback of the config keys because its last path segment is the ABI spelled exactly as
 * Gradle wants it. `hardware-qemu.ini` is last and matters most for CI: the emulator writes it
 * on every boot, so it is always present in an AVD restored from cache — the one case where
 * config.ini has proven unreliable.
 */
const ABI_SOURCES = [
  { file: 'config.ini', key: 'abi.type', parse: (value) => value },
  {
    file: 'config.ini',
    key: 'image.sysdir.1',
    parse: (value) => value.replace(/\/+$/, '').split('/').pop(),
  },
  { file: 'config.ini', key: 'hw.cpu.arch', parse: (value) => CPU_ARCH_TO_ABI[value] || null },
  { file: 'hardware-qemu.ini', key: 'hw.cpu.arch', parse: (value) => CPU_ARCH_TO_ABI[value] || null },
];

function avdAbi(name) {
  const home = avdHome();
  let dir = path.join(home, `${name}.avd`);
  // The .ini beside the .avd directory may point somewhere else entirely.
  const pointed = readIni(path.join(home, `${name}.ini`))?.get('path');
  if (pointed) dir = pointed;

  const parsed = new Map();
  const read = (file) => {
    if (!parsed.has(file)) parsed.set(file, readIni(path.join(dir, file)));
    return parsed.get(file);
  };

  const tried = [];
  for (const { file, key, parse } of ABI_SOURCES) {
    const ini = read(file);
    if (!ini) {
      tried.push(`${file} (unreadable)`);
      continue;
    }
    const raw = ini.get(key);
    if (raw === undefined) {
      tried.push(`${file}:${key} (absent)`);
      continue;
    }
    const abi = parse(raw);
    if (abi && KNOWN_ABIS.includes(abi)) return abi;
    tried.push(`${file}:${key}="${raw}" (unrecognised)`);
  }

  // Reported rather than swallowed, and with the keys the config *does* carry: this fell back
  // silently on CI, and the fallback builds every architecture — correct, but several times
  // slower, and indistinguishable from success in a green run. The key sample is what makes a
  // repeat failure diagnosable from the CI log alone, without another round-trip.
  const config = read('config.ini');
  const sample = config ? ` — config.ini carries ${[...config.keys()].slice(0, 8).join(', ')}` : '';
  warn(
    `could not read the ABI of AVD "${name}" in ${dir}: ` +
      `${[...new Set(tried)].join(', ')}${sample}`
  );
  return null;
}

/**
 * Returns the name of the AVD to boot, creating one if necessary. `javaHome` is
 * passed through to avdmanager/sdkmanager — both are java launchers and would
 * fail with a bare "java not found" on machines where the JDK is only reachable
 * via JAVA_HOME (e.g. the Android Studio JBR).
 */
function ensureAvd(sdk, javaHome) {
  const avdmanager = findAvdmanager(sdk);
  // Every AVD tool gets the same home — see avdHome(). Creating it up front matters on a
  // fresh machine: avdmanager will happily create the AVD elsewhere if this path is absent.
  fs.mkdirSync(avdHome(), { recursive: true });
  const toolEnv = { ANDROID_AVD_HOME: avdHome(), ...(javaHome ? { JAVA_HOME: javaHome } : {}) };
  const existing = listExistingAvds(sdk);

  // Reuse the requested AVD if it already exists (the "no per-run setup" happy
  // path once one has been created).
  if (existing.includes(AVD_NAME)) {
    log(`using existing AVD "${AVD_NAME}"`);
    return AVD_NAME;
  }

  // An explicitly requested AVD that doesn't exist is a typo, not a cue to boot
  // something else.
  if (process.env.MAESTRO_AVD) {
    fail(
      `MAESTRO_AVD="${AVD_NAME}" does not exist. AVDs found: ` +
        `${existing.length ? existing.join(', ') : '(none)'}.`
    );
  }

  if (!avdmanager) {
    // No cmdline-tools → cannot create an AVD. Fall back to any existing AVD so
    // a machine that already has one (e.g. via Android Studio) still works.
    if (existing.length > 0) {
      warn(`avdmanager not found under ${sdk}/cmdline-tools — reusing existing AVD ` +
        `"${existing[0]}" instead of creating "${AVD_NAME}". Install cmdline-tools ` +
        '(`sdkmanager "cmdline-tools;latest"`) for full self-provisioning, or set ' +
        'MAESTRO_AVD to pick a specific one.');
      return existing[0];
    }
    fail(
      `No AVD named "${AVD_NAME}" and no avdmanager under ${sdk} to create one. ` +
        'Install Android cmdline-tools (`sdkmanager "cmdline-tools;latest"`) and re-run.'
    );
  }

  const sdkmanager = findSdkmanager(sdk);
  const installed = installedSystemImages(sdk);

  // Pick an installed image, else install one via sdkmanager (network needed).
  let image = installed.find((i) => i.image === PREFERRED_SYSTEM_IMAGE)?.image;
  if (!image && installed.length > 0) {
    warn(`${PREFERRED_SYSTEM_IMAGE} not installed — using ${installed[0].image}`);
    image = installed[0].image;
  }
  if (!image) {
    if (!sdkmanager) {
      fail(
        `No Android system image installed and no sdkmanager to install one. ` +
          `Install "${PREFERRED_SYSTEM_IMAGE}" via Android Studio or cmdline-tools.`
      );
    }
    log('accepting SDK licenses…');
    runSync('bash', ['-c', `yes | "${sdkmanager}" --licenses > /dev/null 2>&1`], {
      env: { ...toolEnv, ANDROID_HOME: sdk },
    });
    log(`installing ${PREFERRED_SYSTEM_IMAGE} (first run downloads ~1 GB)…`);
    const res = runSync(sdkmanager, [PREFERRED_SYSTEM_IMAGE], {
      env: { ...toolEnv, ANDROID_HOME: sdk },
    });
    if (res.status !== 0) {
      fail(`sdkmanager failed to install ${PREFERRED_SYSTEM_IMAGE} (network?).`);
    }
    image = PREFERRED_SYSTEM_IMAGE;
  }

  log(`creating AVD "${AVD_NAME}" (${image})…`);
  const create = runSync('bash', [
    '-c',
    `echo no | "${avdmanager}" create avd -n "${AVD_NAME}" -k "${image}" -d pixel_7 --force`,
  ], { env: toolEnv });
  if (create.status !== 0) {
    fail(`avdmanager failed to create "${AVD_NAME}".`);
  }
  log(`AVD "${AVD_NAME}" ready`);
  return AVD_NAME;
}

// ─── Emulator lifecycle ───────────────────────────────────────────────────────

/**
 * adb, always pinned to one device. Every call after the emulator is up passes
 * `serial`; without `-s` a second attached device or emulator (a phone plugged
 * in, a leftover emulator from an aborted run) makes every command ambiguous —
 * adb then errors out, or worse, wipes app data on the wrong device.
 */
function adb(sdk, args, serial = null) {
  const prefix = serial ? ['-s', serial] : [];
  return runSync(path.join(sdk, 'platform-tools', 'adb'), [...prefix, ...args]);
}

/** Serial numbers adb currently lists, in any state. */
function listDeviceSerials(sdk) {
  try {
    const { status, stdout } = adb(sdk, ['devices']);
    if (status !== 0) return [];
    return stdout
      .split('\n')
      .slice(1) // "List of devices attached"
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * A log file descriptor a child can be spawned onto.
 *
 * Deliberately `openSync` and not `fs.createWriteStream`: a WriteStream opens
 * its file asynchronously, so its `fd` is still `null` on the next line and
 * `spawn` rejects it with `ERR_INVALID_ARG_VALUE: The argument 'stdio' is
 * invalid`. That crashed the runner the moment it tried to boot the emulator.
 */
function openLogFd(name) {
  return fs.openSync(path.join(ARTIFACTS_DIR, name), 'a');
}

function bootEmulator(sdk, avd) {
  const emulator = path.join(sdk, 'emulator', 'emulator');
  log(`booting emulator "-avd ${avd}" (headless) from ${avdHome()}…`);

  const args = [
    '-avd', avd,
    '-no-window',       // headless — safe for CI and for the reviewer's machine
    '-no-audio',
    '-no-boot-anim',
    '-no-snapshot',     // deterministic cold boot every run
    '-gpu', 'swiftshader_indirect',
    '-camera-back', 'virtualscene', // the scan tab renders a scene instead of black
    ...(process.env.MAESTRO_EMULATOR_ARGS ? process.env.MAESTRO_EMULATOR_ARGS.split(' ') : []),
  ];

  const logFd = openLogFd('emulator.log');
  const child = spawn(emulator, args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    // Same AVD home the AVD was created in. Inheriting the ambient environment is what let
    // avdmanager and the emulator disagree: creation succeeded, the boot then reported
    // "Unknown AVD name [breadsheet-e2e]" and sat there until the boot timeout.
    env: { ...process.env, ANDROID_AVD_HOME: avdHome() },
  });
  child.unref();
  return child;
}

/**
 * Waits for the emulator we just started and returns its serial.
 *
 * `preexisting` is the serial list from before the boot, so a device that was
 * already attached is never mistaken for ours. Deliberately not
 * `adb wait-for-device`: that call has no timeout, so an emulator that dies
 * during boot hangs the runner forever instead of failing at BOOT_TIMEOUT_MS.
 */
function waitForBoot(sdk, preexisting = []) {
  log('waiting for device…');
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let serial = null;

  while (Date.now() < deadline) {
    if (!serial) {
      const fresh = listDeviceSerials(sdk).filter(
        (s) => s.startsWith('emulator-') && !preexisting.includes(s)
      );
      if (fresh.length > 0) {
        serial = fresh[0];
        log(`device attached: ${serial}`);
      }
    }
    if (serial) {
      try {
        const { stdout } = adb(sdk, ['shell', 'getprop', 'sys.boot_completed'], serial);
        if (stdout.trim() === '1') {
          const { stdout: api } = adb(
            sdk, ['shell', 'getprop', 'ro.build.version.sdk'], serial
          );
          log(`device booted (API ${api.trim() || 'unknown'})`);
          return serial;
        }
      } catch {
        // adb not ready yet
      }
    }
    sleepSync(5000);
  }

  fail(
    `emulator did not ${serial ? 'finish booting' : 'attach to adb'} within ` +
      `${BOOT_TIMEOUT_MS / 1000}s (see e2e/maestro/artifacts/emulator.log).`
  );
}

// ─── Build, install, Metro ────────────────────────────────────────────────────

/**
 * Regenerate android/ when it is missing, or when the config that produced it has changed.
 *
 * Previously this ran only when android/ was absent, so an app.json or dependency change
 * left a stale native project in place and the suite tested a build that no longer matched
 * the source. The fingerprint covers app.json (scheme, permissions, plugins — all of which
 * prebuild bakes into the manifest) and package.json (native modules arrive as dependencies).
 * A changed fingerprint forces `--clean`, because prebuild merges into an existing tree and
 * a removed plugin would otherwise survive in the generated manifest.
 */
function appConfigFingerprint() {
  const crypto = require('node:crypto');
  const parts = [];
  for (const file of ['app.json', 'package.json']) {
    try {
      parts.push(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    } catch {
      parts.push('');
    }
  }
  return crypto.createHash('sha256').update(parts.join('\0')).digest('hex');
}

function ensureNativeProject() {
  const fingerprint = appConfigFingerprint();
  const havePrebuild = fs.existsSync(ANDROID_DIR);
  let stale = false;
  if (havePrebuild) {
    let stamped = null;
    try {
      stamped = fs.readFileSync(PREBUILD_STAMP, 'utf8').trim();
    } catch {
      stamped = null; // generated before stamping existed — treat as unknown, not stale
    }
    stale = stamped !== null && stamped !== fingerprint;
  }

  if (havePrebuild && !stale) return;
  log(
    havePrebuild
      ? 'app.json/package.json changed since android/ was generated — re-running expo prebuild --clean…'
      : 'android/ not present — running expo prebuild…'
  );
  const args = ['prebuild', '--platform', 'android', '--no-install'];
  if (stale) args.push('--clean');
  const pre = runSync(path.join(ROOT, 'node_modules', '.bin', 'expo'), args);
  if (pre.status !== 0) fail('expo prebuild failed (see output above).');
  fs.writeFileSync(PREBUILD_STAMP, fingerprint);
}

function gradleEnv(sdk, java) {
  const env = { ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk };
  // Only point JAVA_HOME at a concrete path; if `java` came from PATH, leave JAVA_HOME alone
  // and let Gradle find the same JDK on PATH.
  if (path.isAbsolute(java)) env.JAVA_HOME = path.dirname(path.dirname(java));
  return env;
}

/**
 * Compile the debug APK. Deliberately `assembleDebug` and NOT `installDebug`: assembling
 * needs no device, so the caller can start it before the emulator has booted and let the two
 * overlap. `installDebug` would drag the whole build in behind the boot for no reason — the
 * emulator used to sit idle for the entire Gradle run, competing for CPU and RAM with it.
 */
async function assembleDebug(sdk, java, abi) {
  ensureNativeProject();

  const gradlew = path.join(ANDROID_DIR, 'gradlew');
  if (!fs.existsSync(gradlew)) {
    fail('android/gradlew missing after prebuild — cannot build the debug APK.');
  }

  // The 10–40 minute figure is a *first-build* cost (toolchain download + compiling every
  // native module for each ABI). Once ~/.gradle is populated the same step is seconds, and
  // printing the scary number every time trains people to ignore it.
  const gradleCachePrimed = fs.existsSync(path.join(os.homedir(), '.gradle', 'caches'));
  log(
    gradleCachePrimed
      ? `building debug APK${canOverlapBuildAndBoot() ? ' (in parallel with the emulator boot)' : ''}…`
      : 'building debug APK (first Gradle run downloads the Android toolchain; this can take ' +
          '10–40 minutes — later runs are seconds)…'
  );
  // `await` is load-bearing: runStreaming returns a Promise, so reading `.code` off the
  // unresolved Promise made every run abort with "exit undefined" while Gradle kept going.
  const gradleArgs = [':app:assembleDebug', '-x', 'lint'];
  // A Gradle daemon is worth keeping on a developer machine — it is why a warm build here is
  // seconds — and worthless on CI, where the VM is discarded straight afterwards. Deliberately
  // NOT `gradlew --stop` in teardown: that kills every daemon for this Gradle version,
  // including the ones the developer's IDE is using. Gradle reuses one idle daemon across
  // runs rather than stacking them (verified with `gradlew --status`); the memory pressure
  // seen during this ticket came from two daemons for two different JDKs, not from a leak.
  if (process.env.CI) gradleArgs.push('--no-daemon');
  if (abi) {
    gradleArgs.push(`-PreactNativeArchitectures=${abi}`);
    log(`building for ${abi} only — the ABI this AVD runs`);
  } else {
    warn('building every architecture, which is much slower — see the ABI warning above');
  }
  const res = await runStreaming(gradlew, gradleArgs, {
    cwd: ANDROID_DIR,
    env: gradleEnv(sdk, java),
    timeoutMs: GRADLE_TIMEOUT_MS,
  });
  if (res.code !== 0) {
    fail(`Gradle :app:assembleDebug failed (exit ${res.code}).`, res.code || 1);
  }
  if (!fs.existsSync(DEBUG_APK)) {
    fail(`Gradle reported success but ${DEBUG_APK} is missing.`);
  }
  exportBuiltApk();
}

/**
 * Reusing a debug APK across runs (MAESTRO_APK / MAESTRO_APK_OUT).
 *
 * A debug build does not embed the JS bundle; the app loads it from Metro at launch (see
 * startMetro). So the APK depends only on the native inputs: autolinked native modules,
 * config plugins and app.json. CI keys a cache on `@expo/fingerprint` over exactly those
 * (.github/workflows/test-native-e2e.yml). A PR that only changes JS, which is nearly every
 * PR that triggers this suite, then installs the cached APK instead of spending ~9 minutes
 * in Gradle. The cache key, not this runner, decides whether a cached APK is still valid.
 *
 * Exported only from here, after Gradle and the existence check both succeeded, so a failed
 * or partial build can never reach the cache.
 */
function exportBuiltApk() {
  const out = process.env.MAESTRO_APK_OUT;
  if (!out) return;
  const dest = path.resolve(out);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(DEBUG_APK, dest);
  log(`copied the debug APK to ${dest} (MAESTRO_APK_OUT)`);
}

/**
 * The prebuilt APK named by MAESTRO_APK, checked before anything boots. The file must exist
 * and carry native libraries for the AVD's ABI: an APK built for another ABI installs fine
 * and then crashes on launch, which reads as a flow failure rather than a wrong artifact.
 * Zip entry names are stored uncompressed, so a byte search for `lib/<abi>/` is enough
 * without unpacking anything.
 */
function resolvePrebuiltApk(abi) {
  const raw = process.env.MAESTRO_APK;
  if (!raw) return null;
  const apk = path.resolve(raw);
  if (!fs.existsSync(apk)) {
    fail(`MAESTRO_APK=${raw} does not exist. Unset it to build the debug APK instead.`);
  }
  if (abi && !apkHasAbi(apk, abi)) {
    fail(
      `MAESTRO_APK=${raw} has no native libraries for ${abi}, the ABI of the AVD this run ` +
        'boots, so it was built for another ABI. Unset MAESTRO_APK to rebuild.'
    );
  }
  return apk;
}

function apkHasAbi(apk, abi) {
  return fs.readFileSync(apk).includes(Buffer.from(`lib/${abi}/`));
}

/**
 * Install the assembled APK onto the emulator this run started.
 *
 * `adb install` can print "Failure [...]" while still exiting 0, so the output is checked as
 * well as the status — a silently failed install would surface much later as a flow timing
 * out on a screen belonging to the previous build.
 */
function installDebugApk(sdk, serial, apk = DEBUG_APK) {
  log(`installing debug APK ${apk}…`);
  const res = adb(sdk, ['install', '-r', '-d', apk], serial);
  const output = `${res.stdout || ''}${res.stderr || ''}`;
  if (res.status !== 0 || /Failure|Error:/i.test(output)) {
    fail(`adb install of the debug APK failed. ${output.trim()}`);
  }
}

function startMetro() {
  log(`starting Metro on :${METRO_PORT}…`);
  const logFd = openLogFd('metro.log');
  const child = spawn(
    path.join(ROOT, 'node_modules', '.bin', 'expo'),
    ['start', '--port', METRO_PORT],
    { detached: true, stdio: ['ignore', logFd, logFd] }
  );
  child.unref();
  return child;
}

async function waitForMetro() {
  const deadline = Date.now() + METRO_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const body = await httpGet(METRO_STATUS_URL);
    if (body && body.includes('packager-status:running')) {
      log('Metro is serving');
      return;
    }
    sleepSync(3000);
  }
  fail(
    `Metro did not come up on :${METRO_PORT} within ${METRO_TIMEOUT_MS / 1000}s ` +
      '(see e2e/maestro/artifacts/metro.log).'
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  if (!fs.existsSync(FLOWS_DIR) || !fs.readdirSync(FLOWS_DIR).some((f) => f.endsWith('.yaml'))) {
    fail(`no Maestro flows found under ${FLOWS_DIR}`);
  }

  // Every prerequisite is resolved BEFORE anything slow or stateful starts —
  // including Maestro itself, which used to be looked up after the Gradle build
  // and so reported "not installed" 10–40 minutes into a run.
  ensureAppCredentials();
  const sdk = resolveAndroidSdk();
  const java = resolveJava();
  log(`Android SDK: ${sdk}`);
  log(`Java: ${java}`);
  const maestro = resolveMaestro();
  log(`Maestro: ${maestro}`);

  const avd = ensureAvd(sdk, path.isAbsolute(java) ? path.dirname(path.dirname(java)) : undefined);
  log(`AVD: ${avd}`);
  // Read before anything boots: the APK must match the device it will be installed on.
  const targetAbi = avdAbi(avd);
  const prebuiltApk = resolvePrebuiltApk(targetAbi);
  if (prebuiltApk) log(`prebuilt APK: ${prebuiltApk} (MAESTRO_APK), skipping prebuild and Gradle`);

  // Lets a machine verify that it *can* run the suite (SDK, JDK, Maestro, AVD
  // all resolved) in a second, instead of finding out 40 minutes into a Gradle
  // build. The prerequisite phase is the part that varies per machine.
  if (process.env.MAESTRO_PREREQS_ONLY === '1') {
    log('MAESTRO_PREREQS_ONLY=1 — prerequisites OK, not booting the emulator');
    process.exit(0);
  }

  const preexistingSerials = listDeviceSerials(sdk);
  let emulatorChild = null;
  let metroChild = null;
  let serial = null;
  let exitCode = 1;

  try {
    // Overlapping the Gradle build with the emulator boot is a win on a developer machine and
    // a liability on a small CI runner: a cold RN build saturates every core, the emulator
    // gets starved, and it fails to attach to adb inside BOOT_TIMEOUT_MS while Gradle is still
    // compiling. Observed on a 2-vCPU GitHub runner — "emulator did not attach to adb within
    // 300s" with Kotlin tasks still printing after teardown. So overlap only where there are
    // cores to spare, and otherwise build first and boot into an idle machine.
    if (prebuiltApk) {
      emulatorChild = bootEmulator(sdk, avd);
      serial = waitForBoot(sdk, preexistingSerials);
    } else if (canOverlapBuildAndBoot()) {
      emulatorChild = bootEmulator(sdk, avd);
      const assembling = assembleDebug(sdk, java, targetAbi);
      serial = waitForBoot(sdk, preexistingSerials);
      await assembling;
    } else {
      log(`${cpuCount()} usable CPU(s) — building first, then booting (no overlap)`);
      await assembleDebug(sdk, java, targetAbi);
      emulatorChild = bootEmulator(sdk, avd);
      serial = waitForBoot(sdk, preexistingSerials);
    }

    adb(sdk, ['reverse', `tcp:${METRO_PORT}`, `tcp:${METRO_PORT}`], serial);

    // Build + install FIRST: `pm clear` / `pm grant` both need the package to
    // exist. Run before the install and they fail silently on a fresh device
    // (no CAMERA pre-grant) and never wipe anything on a repeat run — leaving
    // the previous run's guest session behind, which lands the app in the tabs
    // and stalls both flows on "Continue as Guest".
    installDebugApk(sdk, serial, prebuiltApk || DEBUG_APK);

    // Fresh app data (wipes any leftover session from a previous run)…
    const cleared = adb(sdk, ['shell', 'pm', 'clear', APP_ID], serial);
    if (cleared.status !== 0) {
      fail(
        `adb pm clear ${APP_ID} failed after install — the flows need a signed-out ` +
          `app to start from. ${cleared.stderr || cleared.stdout}`
      );
    }
    // …then pre-grant the camera permission so the flow never races a system
    // dialog (the flow also taps "While using the app" defensively). `pm clear`
    // revokes runtime permissions, so this must follow it.
    const granted = adb(
      sdk, ['shell', 'pm', 'grant', APP_ID, 'android.permission.CAMERA'], serial
    );
    if (granted.status !== 0) {
      warn(
        `could not pre-grant CAMERA (${granted.stderr || granted.stdout}) — the flow ` +
          'falls back to tapping the runtime permission dialog.'
      );
    }

    metroChild = startMetro();
    await waitForMetro();

    const flowTarget = process.env.MAESTRO_FLOW
      ? path.join(FLOWS_DIR, process.env.MAESTRO_FLOW)
      : FLOWS_DIR;
    log(`running Maestro flows: ${flowTarget}`);
    const res = await runStreaming(maestro, ['test', flowTarget], {
      env: serial ? { ANDROID_SERIAL: serial } : {},
    });
    exitCode = res.code === 0 ? 0 : 1;
  } finally {
    teardown(sdk, serial, metroChild, emulatorChild);
  }

  if (exitCode === 0) {
    log('✅ all Maestro flows passed');
  } else {
    console.error(
      '[test:maestro] ❌ Maestro flows failed — see output above, e2e/maestro/artifacts/ for\n' +
        '  emulator/Metro logs, and ~/.maestro/tests/<newest>/ for per-step screenshots and\n' +
        '  view hierarchies (the hierarchy JSON is what tells you a view was off-screen\n' +
        '  rather than mis-identified).'
    );
  }
  process.exit(exitCode);
}

function teardown(sdk, serial, metroChild, emulatorChild) {
  log('tearing down…');
  try {
    adb(sdk, ['emu', 'kill'], serial);
  } catch {
    // emulator already gone
  }
  // Both children are `detached`, so they lead their own process groups: expo
  // spawns Metro as a child of itself, and killing only the wrapper leaves Metro
  // holding :8081 for the next run. Negative pid signals the whole group.
  for (const child of [metroChild, emulatorChild]) {
    if (!child || !child.pid) continue;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    if (err instanceof RunnerError) {
      console.error(`[test:maestro] ERROR: ${err.message}`);
      process.exit(err.code);
    }
    console.error('[test:maestro] unexpected failure:', err);
    process.exit(1);
  });
} else {
  // Required (not executed) → expose the pure helpers so the units that carried
  // the defects — AVD discovery, JDK version parsing — are directly testable.
  // See scripts/test-maestro-wiring.test.js.
  module.exports = {
    RunnerError,
    REQUIRED_APP_ENV,
    adb,
    bootEmulator,
    assembleDebug,
    apkHasAbi,
    exportBuiltApk,
    resolvePrebuiltApk,
    canOverlapBuildAndBoot,
    cpuCount,
    ensureNativeProject,
    ensureAppCredentials,
    javaMajorVersion,
    listDeviceSerials,
    listExistingAvds,
    teardown,
    waitForBoot,
    MIN_JAVA_MAJOR,
    MAX_JAVA_MAJOR,
    avdAbi,
    ABI_SOURCES,
    KNOWN_ABIS,
    isUsableJavaMajor,
    installedSystemImages,
    systemJavaCandidates,
  };
}
