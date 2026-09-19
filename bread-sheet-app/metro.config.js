const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Exclude test files from the Metro bundle so Expo Router's require.context
// in app/ doesn't try to register them as routes. Jest doesn't go through
// Metro, so colocated *.test.tsx files still run via `npm test`.
//
// APPENDED to Expo's defaults, never substituted for them: getDefaultConfig
// already blocks `__tests__/`, `.expo/types`, `.expo/web/cache` and the native
// build directories, and assigning a fresh array handed all of those back to
// the bundler — an `app/**/__tests__/x.tsx` would have been registered as a
// route. `[].concat` normalises the default, which Metro may express either as
// an array or as a single RegExp.
config.resolver.blockList = [
  ...[].concat(config.resolver.blockList ?? []),
  /.*\.test\.(ts|tsx|js|jsx)$/,
];

module.exports = config;
