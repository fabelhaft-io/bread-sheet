# Maestro Android flows

`barcode-scan.yaml` is the native-only camera smoke flow. It starts as an anonymous user,
opens the Scan tab, grants camera access, waits for the camera view, and verifies that a
real EAN-13 decode navigates to the product screen.

## Run locally

Run the flow with:

```sh
npm run test:maestro
```

`run-maestro-android.sh` provisions the Android command-line tools (under
`$ANDROID_HOME`, defaulting to `$HOME/Android/Sdk`) and Maestro if they are absent. It then
accepts SDK licenses, installs the API 35 platform/system image, creates the
`bread-sheet-api-35` AVD when needed, boots it headlessly, builds and installs the debug
client, and runs the flow. Set `ANDROID_HOME` (or `ANDROID_SDK_ROOT`) and
`ANDROID_AVD_NAME` to override the defaults. Java 17+, `curl`, and `unzip` are the only
host prerequisites.

Headless emulators cannot receive camera frames from Maestro. The debug build therefore
exposes a fixture button only when `EXPO_PUBLIC_MAESTRO_BARCODE` is set; the runner supplies
an EAN-13 default and the button invokes the same barcode callback used by `expo-camera`.
This keeps the scan/navigation path deterministic without a manual camera fixture, while the
camera permission and native `CameraView` are still exercised. Production builds never render
the fixture control.

The app's API must be reachable from the emulator for the final product-screen assertion.
For a local API, use an emulator-reachable host address rather than `localhost`.
