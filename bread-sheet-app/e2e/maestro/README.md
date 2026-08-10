# Maestro Android flows

`barcode-scan.yaml` is the native-only camera smoke flow. It starts as an anonymous user,
opens the Scan tab, grants camera access, waits for the native camera view, and verifies that
the debug barcode fixture drives the same scan callback and navigates to the product screen.
The fixture is deliberately deterministic for headless emulators; it is not a claim that Maestro
has supplied a camera frame or performed an optical decode.

## Run locally

Run the flow with:

```sh
npm run test:maestro
```

`run-maestro-android.sh` provisions the Android command-line tools (under
`$ANDROID_HOME`, defaulting to `$HOME/Android/Sdk`) and Maestro if they are absent. It also downloads a cached Temurin Java 17 runtime when the
host has no suitable JDK. It then accepts SDK licenses, installs the API 35 platform/system
image, creates the `bread-sheet-api-35` AVD when needed, boots it headlessly, builds and
installs the debug client, and runs the flow. Set `ANDROID_HOME` (or `ANDROID_SDK_ROOT`)
and `ANDROID_AVD_NAME` to override the defaults. `curl`, `unzip`, and `tar` are the only
host prerequisites (the first run requires network access).

### Metro lifecycle

A debug build has no embedded JS bundle, so the installed app fetches it from Metro at
launch. The runner therefore keeps a Metro server alive on `8081` (override with
`EXPO_METRO_PORT`) for the whole run: it starts `expo start` in the background before
`expo run:android`, waits for the `/status` endpoint, and only tears it down after the
Maestro flow finishes. `expo run:android --no-bundler` reuses that server — the CLI's
headless dev server is a mock whose `stopAsync` does not touch the process owning the
port — and the runner verifies Metro is still serving after the native build so a future
CLI change that stops reusing it fails fast instead of producing an "Unable to load
script" app. An already-running Metro (e.g. your own `npm start`) is detected via
`/status` and reused without being stopped on exit. Before installing the app the runner
also pre-warms the Android debug bundle (the manifest's `launchAsset.url`) so the app's
first frame after install does not stall on a cold Metro build; `barcode-scan.yaml`
additionally waits up to 60s for the login screen before its first tap.

The runner fails fast (before any download or emulator boot) when a prerequisite would
otherwise only surface as a crash or a mid-flow assertion:

- `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` must be
  set (see `bread-sheet-app/.env.example`) — `lib/supabase.ts` throws at import time
  without them, so the guest sign-in step could not start.
- The API must be reachable — the flow's final product-screen assertion needs it. A
  host-local `EXPO_PUBLIC_API_URL` (`localhost`/`127.0.0.1`) is translated to the
  emulator alias automatically, and the runner checks the host-side URL before
  provisioning. Start the local API (`cd server && npm run dev`, listening on `:3000`)
  or point `EXPO_PUBLIC_API_URL` at a reachable staging URL.

Headless emulators cannot receive camera frames from Maestro. The debug build therefore
exposes a fixture button only when `EXPO_PUBLIC_MAESTRO_BARCODE` is set; the runner supplies
an EAN-13 default and the button invokes the same barcode callback used by `expo-camera`.
This keeps the scan/navigation path deterministic without a manual camera fixture, while the
camera permission and native `CameraView` are still exercised. Production builds never render
the fixture control.

The app's API must be reachable from the emulator for the final product-screen assertion.
The runner provides a reproducible default of `http://10.0.2.2:3000` (the Android emulator's
host-machine alias), and translates `localhost`/`127.0.0.1` in `EXPO_PUBLIC_API_URL` to that
alias before building. Start the local API using the repository's documented development
command, or set `EXPO_PUBLIC_API_URL` to a reachable staging URL; no per-run URL rewrite is
needed. Cloud Supabase credentials still need to be present in the app environment for guest
authentication.

The fixture is not optical barcode decoding. It is a deliberate limitation of headless Android
emulators: Maestro cannot inject a camera frame. Therefore this flow proves permission, native
`CameraView`, the barcode callback, API lookup, and navigation, but does not by itself satisfy a
strict “real camera frame decoded” interpretation of the acceptance criterion. A physical-device
or emulator virtual-camera flow remains required if that interpretation is mandatory.
