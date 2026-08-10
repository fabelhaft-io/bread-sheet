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
 *   MAESTRO_INSTALL=0                 never auto-install the Maestro CLI
 *   MAESTRO_METRO_PORT                Metro port (default 8081)
 *   MAESTRO_FLOW                      run a single flow file instead of e2e/maestro
 *   MAESTRO_SKIP_ENV_CHECK=1          don't require bread-sheet-app/.env
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
const FLOWS_DIR = path.join(ROOT, 'e2e', 'maestro');
const ARTIFACTS_DIR = path.join(FLOWS_DIR, 'artifacts');
const ENV_FILE = path.join(ROOT, '.env');
const ANDROID_DIR = path.join(ROOT, 'android');

function log(...args) {
  console.log('[test:maestro]', ...args);
}

function warn(...args) {
  console.warn('[test:maestro] WARN:', ...args);
}

function fail(message, code = 2) {
  console.error(`[test:maestro] ERROR: ${message}`);
  process.exit(code);
}

/** Blocking sleep without spawning a child process. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Run a short-lived command to completion, returning { status, stdout }. */
function runSync(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    env: { ...process.env, ...opts.env },
    cwd: opts.cwd || ROOT,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: (res.stdout || '').trim() };
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

function resolveAndroidSdk() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), 'Android', 'Sdk'),
    '/usr/local/android-sdk',
    '/opt/android-sdk',
    '/opt/android/sdk',
  ].filter(Boolean);

  for (const sdk of candidates) {
    if (
      fs.existsSync(path.join(sdk, 'emulator', 'emulator')) &&
      fs.existsSync(path.join(sdk, 'platform-tools', 'adb'))
    ) {
      return sdk;
    }
  }
  fail(
    'Android SDK not found. Set ANDROID_HOME (needs emulator/ and platform-tools/, ' +
      'e.g. ~/Android/Sdk from Android Studio). Install with ' +
      '`sdkmanager "emulator" "platform-tools" "system-images;android-35;google_apis;x86_64"` ' +
      'or via Android Studio → SDK Manager.'
  );
}

function resolveJava() {
  const candidates = [
    process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, 'bin', 'java'),
    'java', // relies on PATH
    '/opt/android-studio/jbr/bin/java',
    path.join(os.homedir(), 'android-studio', 'jbr', 'bin', 'java'),
    '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java',
  ].filter(Boolean);

  for (const java of candidates) {
    try {
      const res = runSync(java, ['-version']);
      if (res.status === 0) return java;
    } catch {
      // keep probing
    }
  }
  fail(
    'JDK 17+ not found (required for the Gradle build of the debug APK). Set JAVA_HOME ' +
      'or install a JDK (Android Studio ships one at /opt/android-studio/jbr on Linux).'
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

  if (process.env.MAESTRO_INSTALL === '0') {
    fail(
      'Maestro CLI not installed (MAESTRO_INSTALL=0). Install with ' +
        '`curl -Ls "https://get.maestro.mobile.dev" | bash` then re-run.'
    );
  }
  log('Maestro CLI not found — installing to ~/.maestro via the official script…');
  const res = runSync('bash', ['-c', 'curl -Ls "https://get.maestro.mobile.dev" | bash']);
  if (res.status !== 0 || !fs.existsSync(envMaestro)) {
    fail(
      'Maestro CLI install failed (network?). Install manually with ' +
        '`curl -Ls "https://get.maestro.mobile.dev" | bash` then re-run.'
    );
  }
  return envMaestro;
}

function ensureEnvFile() {
  if (process.env.MAESTRO_SKIP_ENV_CHECK === '1') return;
  if (!fs.existsSync(ENV_FILE)) {
    fail(
      'bread-sheet-app/.env is missing — the flows sign in as guest and look up a ' +
        'product, so they need a reachable Supabase project (same prerequisite as ' +
        '`npm run test:e2e`). Copy .env.example → .env and fill in ' +
        'EXPO_PUBLIC_SUPABASE_URL + EXPO_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY. ' +
        '(Set MAESTRO_SKIP_ENV_CHECK=1 to bypass.)'
    );
  }
  const env = fs.readFileSync(ENV_FILE, 'utf8');
  for (const key of ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY']) {
    if (!new RegExp(`^${key}=`, 'm').test(env)) {
      fail(
        `${key} is missing from bread-sheet-app/.env — guest sign-in and product ` +
          'lookup need it (same prerequisite as `npm run test:e2e`).'
      );
    }
  }
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
function installedSystemImages(sdk) {
  const root = path.join(sdk, 'system-images');
  if (!fs.existsSync(root)) return [];
  const found = [];
  for (const apiDir of fs.readdirSync(root)) {
    const match = /^android-(\d+)$/.exec(apiDir);
    if (!match) continue;
    const api = Number(match[1]);
    for (const flavor of ['google_apis', 'default', 'google_apis_playstore']) {
      if (fs.existsSync(path.join(root, apiDir, flavor, 'x86_64'))) {
        found.push({ api, image: `system-images;${apiDir};${flavor};x86_64` });
      }
    }
  }
  found.sort((a, b) => b.api - a.api);
  return found;
}

function listExistingAvds(avdmanager, env = {}) {
  try {
    const { status, stdout } = runSync(avdmanager, ['list', 'avd', '-c'], { env });
    if (status !== 0) return [];
    return stdout.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Returns the name of the AVD to boot, creating one if necessary. `javaHome` is
 * passed through to avdmanager/sdkmanager — both are java launchers and would
 * fail with a bare "java not found" on machines where the JDK is only reachable
 * via JAVA_HOME (e.g. the Android Studio JBR).
 */
function ensureAvd(sdk, javaHome) {
  const avdmanager = findAvdmanager(sdk);
  const toolEnv = javaHome ? { JAVA_HOME: javaHome } : {};
  const existing = avdmanager ? listExistingAvds(avdmanager, toolEnv) : [];

  // Reuse the requested AVD if it already exists (the "no per-run setup" happy
  // path once one has been created).
  if (existing.includes(AVD_NAME)) {
    log(`using existing AVD "${AVD_NAME}"`);
    return AVD_NAME;
  }

  if (!avdmanager) {
    // No cmdline-tools → cannot create an AVD. Fall back to any existing AVD so
    // a machine that already has one (e.g. via Android Studio) still works.
    if (existing.length > 0) {
      warn(`avdmanager not found under ${sdk}/cmdline-tools — reusing existing AVD ` +
        `"${existing[0]}" instead of creating "${AVD_NAME}". Install cmdline-tools ` +
        '(`sdkmanager "cmdline-tools;latest"`) for full self-provisioning.');
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

function adb(sdk, args) {
  return runSync(path.join(sdk, 'platform-tools', 'adb'), args);
}

function bootEmulator(sdk, avd) {
  const emulator = path.join(sdk, 'emulator', 'emulator');
  log(`booting emulator "-avd ${avd}" (headless)…`);

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

  const logFile = fs.createWriteStream(path.join(ARTIFACTS_DIR, 'emulator.log'), { flags: 'a' });
  const child = spawn(emulator, args, {
    detached: true,
    stdio: ['ignore', logFile, logFile],
  });
  child.unref();
  return child;
}

function waitForBoot(sdk) {
  log('waiting for device…');
  adb(sdk, ['wait-for-device']);
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let booted = false;
  while (Date.now() < deadline) {
    try {
      const { stdout } = adb(sdk, ['shell', 'getprop', 'sys.boot_completed']);
      if (stdout.trim() === '1') {
        booted = true;
        break;
      }
    } catch {
      // adb not ready yet
    }
    sleepSync(5000);
  }
  if (!booted) {
    fail(
      `emulator did not finish booting within ${BOOT_TIMEOUT_MS / 1000}s ` +
        '(see e2e/maestro/artifacts/emulator.log).'
    );
  }
  const { stdout: api } = adb(sdk, ['shell', 'getprop', 'ro.build.version.sdk']);
  log(`device booted (API ${api.trim() || 'unknown'})`);
}

// ─── Build, install, Metro ────────────────────────────────────────────────────

function buildAndInstallDebug(sdk, java) {
  if (!fs.existsSync(ANDROID_DIR)) {
    log('android/ not present — running expo prebuild…');
    const pre = runSync(path.join(ROOT, 'node_modules', '.bin', 'expo'), [
      'prebuild',
      '--platform', 'android',
      '--no-install',
    ]);
    if (pre.status !== 0) fail('expo prebuild failed (see output above).');
  }

  const gradlew = path.join(ANDROID_DIR, 'gradlew');
  if (!fs.existsSync(gradlew)) {
    fail('android/gradlew missing after prebuild — cannot build the debug APK.');
  }

  log(
    'building + installing debug APK (first Gradle run downloads dependencies; ' +
      'this can take 10–40 minutes)…'
  );
  const env = { ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk };
  // Only point JAVA_HOME at a concrete JBR path; if `java` came from PATH, leave
  // JAVA_HOME alone and let Gradle find the same JDK on PATH.
  if (path.isAbsolute(java)) env.JAVA_HOME = path.dirname(path.dirname(java));
  const res = runStreaming(gradlew, [':app:installDebug', '-x', 'lint'], {
    cwd: ANDROID_DIR,
    env,
    timeoutMs: GRADLE_TIMEOUT_MS,
  });
  if (res.code !== 0) {
    fail(`Gradle :app:installDebug failed (exit ${res.code}).`, res.code || 1);
  }
}

function startMetro() {
  log(`starting Metro on :${METRO_PORT}…`);
  const logFile = fs.createWriteStream(path.join(ARTIFACTS_DIR, 'metro.log'), { flags: 'a' });
  const child = spawn(
    path.join(ROOT, 'node_modules', '.bin', 'expo'),
    ['start', '--port', METRO_PORT],
    { detached: true, stdio: ['ignore', logFile, logFile] }
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

  ensureEnvFile();
  const sdk = resolveAndroidSdk();
  const java = resolveJava();
  log(`Android SDK: ${sdk}`);
  log(`Java: ${java}`);

  const avd = ensureAvd(sdk, path.isAbsolute(java) ? path.dirname(path.dirname(java)) : undefined);
  const emulatorChild = bootEmulator(sdk, avd);
  let metroChild = null;
  let exitCode = 1;

  try {
    waitForBoot(sdk);
    adb(sdk, ['reverse', `tcp:${METRO_PORT}`, `tcp:${METRO_PORT}`]);

    // Fresh app data (wipes any leftover session from a previous run)…
    adb(sdk, ['shell', 'pm', 'clear', APP_ID]);
    // …then pre-grant the camera permission so the flow never races a system
    // dialog (the flow also taps "While using the app" defensively).
    adb(sdk, ['shell', 'pm', 'grant', APP_ID, 'android.permission.CAMERA']);

    buildAndInstallDebug(sdk, java);
    metroChild = startMetro();
    await waitForMetro();

    const maestro = resolveMaestro();
    const flowTarget = process.env.MAESTRO_FLOW
      ? path.join(FLOWS_DIR, process.env.MAESTRO_FLOW)
      : FLOWS_DIR;
    log(`running Maestro flows: ${flowTarget}`);
    const res = await runStreaming(maestro, ['test', flowTarget]);
    exitCode = res.code === 0 ? 0 : 1;
  } finally {
    log('tearing down…');
    try {
      adb(sdk, ['emu', 'kill']);
    } catch {
      // emulator already gone
    }
    if (metroChild) metroChild.kill('SIGTERM');
    if (emulatorChild && !emulatorChild.killed) emulatorChild.kill('SIGTERM');
  }

  if (exitCode === 0) {
    log('✅ all Maestro flows passed');
  } else {
    console.error(
      '[test:maestro] ❌ Maestro flows failed — see output above and e2e/maestro/artifacts/'
    );
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('[test:maestro] unexpected failure:', err);
  process.exit(1);
});
