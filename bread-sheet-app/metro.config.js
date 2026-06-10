const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Exclude test files from the Metro bundle so Expo Router's require.context
// in app/ doesn't try to register them as routes. Jest doesn't go through
// Metro, so colocated *.test.tsx files still run via `npm test`.
config.resolver.blockList = [/.*\.test\.(ts|tsx|js|jsx)$/];

module.exports = config;
