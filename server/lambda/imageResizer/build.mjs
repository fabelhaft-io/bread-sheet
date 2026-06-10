/**
 * Build script for the image-resizer Lambda.
 *
 * Output: dist/bundle/ — a directory containing index.js (esbuild bundle) and
 * the sharp native binary under node_modules/. Terraform's `archive_file` data
 * source zips this directory into dist/imageResizer.zip.
 *
 * Sharp requires a Linux x64 binary when targeting Lambda (Node.js 24 runtime).
 * This script installs the correct binary into dist/bundle/node_modules before
 * bundling. Run this on any OS — npm handles the cross-platform install.
 *
 * Usage:
 *   npm run build
 *
 * Prerequisites: npm install (devDependencies must be present for esbuild).
 */

import { build } from 'esbuild';
import { rmSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const bundleDir = 'dist/bundle';

// Clean previous build
if (existsSync('dist')) rmSync('dist', { recursive: true });
mkdirSync(bundleDir, { recursive: true });

// Bundle TypeScript source. sharp is excluded because its native .node binary
// cannot be bundled by esbuild — it is installed separately below.
// @aws-sdk/* is excluded because Lambda Node.js 20 runtime includes SDK v3.
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  external: ['@aws-sdk/*', 'sharp'],
  outfile: `${bundleDir}/index.js`,
  format: 'cjs',
});

// Install sharp for Linux x64 into the bundle directory so the Lambda runtime
// can load its native binary. Installing here (not in the top-level node_modules)
// keeps the development sharp install untouched and cross-platform.
writeFileSync(
  `${bundleDir}/package.json`,
  JSON.stringify({ dependencies: { sharp: '0.34.0' } }),
);
// Sharp 0.33+ ships prebuilt binaries via optional dependencies. npm filters
// which optional deps to install based on --os / --cpu / --libc. Lambda's
// Node.js 24 runtime is Linux x64 glibc.
execSync(
  'npm install --os=linux --cpu=x64 --libc=glibc sharp',
  { cwd: bundleDir, stdio: 'inherit' },
);
rmSync(`${bundleDir}/package.json`);
rmSync(`${bundleDir}/package-lock.json`, { force: true });

console.log(`Build complete → ${bundleDir}/`);