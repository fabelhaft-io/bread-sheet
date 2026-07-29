/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
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
