import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    // Vitest 4's default `exclude` is only node_modules + .git — `dist` is no longer
    // in it. Without this line, a local `npm run build` makes `npm test` collect every
    // suite twice (once from src/, once from its compiled twin in dist/), so the run
    // silently reports on stale emitted JS. CI never noticed: it does `npm ci && npm test`
    // with no build step, so dist/ does not exist there.
    exclude: [...configDefaults.exclude, '**/dist/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/generated/**'],
    },
  },
});
