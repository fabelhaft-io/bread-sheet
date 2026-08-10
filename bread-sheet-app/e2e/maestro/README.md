# Maestro Android flows

`barcode-scan.yaml` is the native-only camera smoke flow. It starts as an anonymous user,
opens the Scan tab, grants camera access, waits for the camera view, and verifies that a
real EAN-13 decode navigates to the product screen.

## Run locally

Install the Android command-line tools and Maestro once, then run:

```sh
npm run test:maestro
```

`run-maestro-android.sh` installs the API 35 platform/system image when needed, creates the
`bread-sheet-api-35` AVD when needed, boots it headlessly, builds and installs the debug
client, and runs the flow. Set `ANDROID_HOME` (or `ANDROID_SDK_ROOT`) and
`ANDROID_AVD_NAME` to override the defaults.

Maestro does not generate camera frames. Before running the flow, configure the emulator's
back camera with a barcode fixture (or point the host webcam at an EAN-13 barcode). The
flow deliberately waits for the real `expo-camera` callback rather than mocking it; a
successful navigation is therefore an end-to-end native scan.

The app's API must be reachable from the emulator for the final product-screen assertion.
For a local API, use an emulator-reachable host address rather than `localhost`.
