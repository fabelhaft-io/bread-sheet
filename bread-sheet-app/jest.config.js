/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  // e2e/ holds Playwright specs (npm run test:e2e), not Jest ones — Playwright's `test`
  // refuses to run inside a Jest process, so they must stay out of Jest's test match.
  // Plain '/e2e/' rather than '<rootDir>/e2e/': these are REGEXes, and rootDir is
  // interpolated into them verbatim. A checkout whose absolute path contains a
  // regex metacharacter — e.g. a worktree directory named `fix+something`, where
  // `x+` stops matching a literal '+' — silently fails to match, and Jest then
  // tries to run the Playwright specs, which abort with "Playwright Test needs
  // to be invoked via 'npx playwright test'".
  testPathIgnorePatterns: ['/node_modules/', '/e2e/'],
  moduleNameMapper: {
    // Resolve @/* path alias defined in tsconfig.json
    '^@/(.*)$': '<rootDir>/$1',
    // Reanimated v4 loads native worklets at import time; swap in the JS-only
    // mocks so tests don't fail on missing native modules.
    '^react-native-reanimated$': 'react-native-reanimated/mock',
    '^react-native-worklets$': '<rootDir>/node_modules/react-native-worklets/lib/module/mock',
    // AsyncStorage (the Supabase session store and the offline store's web
    // fallback, P8-001/P8-002) throws at import time without its native
    // module; the package ships an in-memory JS mock for exactly this.
    '^@react-native-async-storage/async-storage$':
      '<rootDir>/node_modules/@react-native-async-storage/async-storage/jest/async-storage-mock.js',
  },
  setupFilesAfterEnv: ['react-native-gesture-handler/jestSetup'],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/(?!next)|@expo-google-fonts|react-navigation|@react-navigation/.*|@unimodules|unimodules|sentry-expo|native-base|react-native-svg)',
  ],
};
