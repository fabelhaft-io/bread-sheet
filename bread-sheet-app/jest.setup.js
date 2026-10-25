// Reanimated 4.7 regression: `initializers.native.ts` (new in 4.7) calls
// `setCSSEventHandler` at import time, but under Jest reanimated selects its JS
// module (`IS_JEST`), whose implementation throws. Every suite importing
// reanimated — including its own `react-native-reanimated/mock` — then fails to
// load. The JS module has no native CSS events to deliver, so a no-op is exact.
// Deep path because the instance isn't part of the public API; this runs in
// `setupFiles`, i.e. in the same per-file module registry the test uses.
// Remove once upstream guards the call (still unguarded in 4.8.0-nightly-20261024).
const { ReanimatedModule } = require('react-native-reanimated/src/ReanimatedModule');

ReanimatedModule.setCSSEventHandler = () => {};
