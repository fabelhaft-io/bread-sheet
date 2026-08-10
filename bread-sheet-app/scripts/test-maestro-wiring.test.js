/**
 * TICKET-P9-003 — wiring guard for the Maestro native E2E suite.
 *
 * The reviewer's test matrix runs `npm --prefix bread-sheet-app run test:maestro`
 * conditionally for camera/scan tickets; this test makes sure that wiring cannot
 * silently rot — the npm script exists, the runner parses, and every flow under
 * e2e/maestro targets the app and drives a scan path. It is deliberately static
 * (no emulator, no Maestro CLI): those are exercised by the runner itself.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

describe('Maestro E2E wiring (TICKET-P9-003)', () => {
  test('package.json exposes the test:maestro script the reviewer runs', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['test:maestro']).toBe('node scripts/test-maestro.js');
  });

  test('runner script exists and parses as valid JavaScript', () => {
    const runner = path.join(ROOT, 'scripts', 'test-maestro.js');
    expect(fs.existsSync(runner)).toBe(true);
    // node --check compiles without executing — catches syntax errors that would
    // otherwise only surface when the reviewer runs the script.
    expect(() => execFileSync(process.execPath, ['--check', runner], { stdio: 'pipe' })).not.toThrow();
  });

  test('every Maestro flow targets the app and contains a scan-driving step', () => {
    const dir = path.join(ROOT, 'e2e', 'maestro');
    const flows = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
      .sort();
    expect(flows.length).toBeGreaterThanOrEqual(1);

    for (const flow of flows) {
      const yaml = fs.readFileSync(path.join(dir, flow), 'utf8');
      expect(yaml).toContain('appId: com.breadsheetexpo.breadsheet');
      // Every flow must end in the product screen for the scanned barcode.
      expect(yaml).toContain('4006381333931');
    }

    // The camera flow must actually drive a scan (the dev-only inject deep link).
    const scan = fs.readFileSync(path.join(dir, 'barcode-scan.yaml'), 'utf8');
    expect(scan).toContain('openLink');
    expect(scan).toContain('breadsheet://scan?inject=');
  });
});
