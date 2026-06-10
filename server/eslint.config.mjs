import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

// Flat config (ESLint 9). Replaces the legacy .eslintrc.js, which could not load
// under "type": "module" and referenced plugins that were never installed.
export default tseslint.config(
  {
    // Generated Prisma client and build output are not ours to lint.
    ignores: ['src/generated/**', 'dist/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // The codebase deliberately prefixes intentionally-unused bindings with
      // `_` (e.g. `_next`, `_opts`, `_buffer`). Honour that convention.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // Test files use `any` freely for Express req/res mocks and SDK fakes.
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  // Disable stylistic rules that conflict with Prettier. Must come last.
  prettier,
);
