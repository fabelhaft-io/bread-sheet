// node --test scripts/ops/*.test.mjs  — no dependencies, no AWS.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  gate,
  switchGate,
  assertPlan,
  snapshotsToPrune,
  lingeringManualSnapshots,
  pickResumeSnapshot,
  snapshotId,
  EXPECTED_DESTROY_SET,
} from './dev-teardown.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

const NOW = new Date('2026-11-08T02:17:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const instanceUpFor = (h) => ({ DBInstanceIdentifier: 'breadsheet-dev-database-1', DBInstanceStatus: 'available', InstanceCreateTime: hoursAgo(h) });

describe('switchGate', () => {
  test('fails when DEV_AUTO_TEARDOWN is unset or blank', () => {
    for (const mode of [undefined, '', '   ']) {
      const d = switchGate({ mode, keepAliveUntil: '', now: NOW });
      assert.equal(d.action, 'fail');
      assert.match(d.reason, /gh variable set DEV_AUTO_TEARDOWN/);
    }
  });

  test('fails on an unknown mode rather than defaulting', () => {
    for (const mode of ['ON', 'true', 'dryrun', 'yes']) {
      assert.equal(switchGate({ mode, keepAliveUntil: '', now: NOW }).action, 'fail', mode);
    }
  });

  test('off is a no-op, and wins over a keep-alive date', () => {
    assert.equal(switchGate({ mode: 'off', keepAliveUntil: 'not-a-date', now: NOW }).action, 'skip');
  });

  test('keep-alive until today or later skips; yesterday continues', () => {
    assert.equal(switchGate({ mode: 'on', keepAliveUntil: '2026-11-08', now: NOW }).action, 'skip');
    assert.equal(switchGate({ mode: 'on', keepAliveUntil: '2026-11-20', now: NOW }).action, 'skip');
    assert.equal(switchGate({ mode: 'on', keepAliveUntil: '2026-11-07', now: NOW }).action, 'continue');
  });

  test('keep-alive compares UTC days, not local time', () => {
    // 23:30 UTC on the 8th is already the 9th in Berlin; the 8th still counts as "today".
    const late = new Date('2026-11-08T23:30:00Z');
    assert.equal(switchGate({ mode: 'on', keepAliveUntil: '2026-11-08', now: late }).action, 'skip');
  });

  test('a malformed keep-alive date fails instead of reading as "no keep-alive"', () => {
    for (const keepAliveUntil of ['20.11.2026', '2026-11-31', '2026-2-1', 'tomorrow']) {
      assert.equal(switchGate({ mode: 'on', keepAliveUntil, now: NOW }).action, 'fail', keepAliveUntil);
    }
  });

  test('unset keep-alive continues', () => {
    assert.equal(switchGate({ mode: 'dry-run', keepAliveUntil: undefined, now: NOW }).action, 'continue');
  });
});

describe('gate', () => {
  const base = { mode: 'on', keepAliveUntil: '', now: NOW };

  test('paused stack (instance not found) is a no-op', () => {
    const d = gate({ ...base, instance: null });
    assert.equal(d.action, 'skip');
    assert.match(d.reason, /already paused/);
  });

  test('a running stack is torn down, however briefly it has been up', () => {
    for (const h of [0.1, 5, 72, 500]) {
      const d = gate({ ...base, instance: instanceUpFor(h) });
      assert.equal(d.action, 'teardown', `${h} h`);
      assert.match(d.reason, /^Running \(up for /);
    }
    assert.match(gate({ ...base, instance: instanceUpFor(26.5) }).reason, /up for 26 h 30 min/);
  });

  test('off and keep-alive still stop a teardown of a running stack', () => {
    assert.equal(gate({ ...base, mode: 'off', instance: instanceUpFor(100) }).action, 'skip');
    assert.equal(gate({ ...base, keepAliveUntil: '2026-11-08', instance: instanceUpFor(100) }).action, 'skip');
  });

  test('dry-run mode, or the dry_run input, marks the teardown as a dry run', () => {
    assert.equal(gate({ ...base, mode: 'dry-run', instance: instanceUpFor(100) }).dryRun, true);
    assert.equal(gate({ ...base, instance: instanceUpFor(100), dryRun: true }).dryRun, true);
    assert.equal(gate({ ...base, instance: instanceUpFor(100) }).dryRun, false);
  });

  test('an unset mode fails before looking at the instance', () => {
    assert.equal(gate({ ...base, mode: undefined, instance: instanceUpFor(100) }).action, 'fail');
  });

  test('an unparsable InstanceCreateTime fails', () => {
    assert.equal(gate({ ...base, instance: { InstanceCreateTime: 'yesterday' } }).action, 'fail');
  });
});

describe('assertPlan', () => {
  test('accepts exactly the five Tier 3 deletes', () => {
    const r = assertPlan(fixture('tier3-plan.ok.json'));
    assert.deepEqual(r.errors, []);
    assert.equal(r.ok, true);
    assert.deepEqual(r.addresses, [...EXPECTED_DESTROY_SET].sort());
  });

  test('rejects an extra address', () => {
    const r = assertPlan(fixture('tier3-plan.extra-address.json'));
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /aws_ssm_parameter\.db_endpoint: not in the expected Tier 3 cascade/);
  });

  test('rejects a replace', () => {
    const r = assertPlan(fixture('tier3-plan.replace.json'));
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /aws_db_instance\.main: planned actions are \[delete, create\]/);
  });

  test('rejects a missing address', () => {
    const r = assertPlan(fixture('tier3-plan.missing-address.json'));
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /aws_budgets_budget_action\.stop_rds: expected .* but not in the plan/);
  });

  test('rejects an update, a create and a deposed object', () => {
    const plan = fixture('tier3-plan.ok.json');
    plan.resource_changes[2].change.actions = ['update'];
    plan.resource_changes.push({ address: 'aws_s3_bucket.images', change: { actions: ['create'] } });
    plan.resource_changes.push({ address: 'aws_db_instance.main', deposed: '00000001', change: { actions: ['delete'] } });
    const r = assertPlan(plan);
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 4); // update, create (2: action + unexpected), deposed
  });

  test('ignores no-op entries', () => {
    const plan = fixture('tier3-plan.ok.json');
    plan.resource_changes.push({ address: 'data.aws_caller_identity.current', mode: 'data', change: { actions: ['no-op'] } });
    assert.equal(assertPlan(plan).ok, true);
  });

  test('rejects an empty plan and an errored plan', () => {
    assert.equal(assertPlan({ resource_changes: [] }).ok, false);
    assert.equal(assertPlan(null).ok, false);
    assert.equal(assertPlan({ ...fixture('tier3-plan.ok.json'), errored: true }).ok, false);
  });
});

const snap = (id, createdAt, { status = 'available', createdBy } = {}) => ({
  DBSnapshotIdentifier: id,
  SnapshotCreateTime: createdAt,
  Status: status,
  TagList: createdBy ? [{ Key: 'created-by', Value: createdBy }, { Key: 'image', Value: `ghcr.io/x/y:${id}` }] : [],
});
const auto = (stamp, createdAt, opts = {}) =>
  snap(`breadsheet-dev-auto-${stamp}`, createdAt, { createdBy: 'dev-auto-teardown', ...opts });

describe('snapshotsToPrune', () => {
  const snapshots = [
    auto('20261101-0217', '2026-11-01T02:17:00Z'),
    auto('20261108-0217', '2026-11-08T02:17:00Z'),
    auto('20261104-0217', '2026-11-04T02:17:00Z'),
    auto('20261028-0217', '2026-10-28T02:17:00Z'),
    snap('breadsheet-dev-pause-2026-08-04', '2026-08-04T10:00:00Z'),
    // Right prefix, no tag: someone named a snapshot by hand. Not ours.
    snap('breadsheet-dev-auto-20260101-0000', '2026-01-01T00:00:00Z'),
    // Right tag, wrong prefix (copy_tags_to_snapshot onto a manual pause). Not ours.
    snap('breadsheet-dev-pause-2026-11-02', '2026-11-02T00:00:00Z', { createdBy: 'dev-auto-teardown' }),
  ];

  test('keeps the newest two automatic snapshots and prunes the rest', () => {
    assert.deepEqual(snapshotsToPrune(snapshots), [
      'breadsheet-dev-auto-20261101-0217',
      'breadsheet-dev-auto-20261028-0217',
    ]);
  });

  test('never prunes manual pause snapshots or untagged lookalikes', () => {
    // keep: 0 prunes every automatic snapshot, and still nothing else.
    assert.deepEqual(snapshotsToPrune(snapshots, { keep: 0 }), [
      'breadsheet-dev-auto-20261108-0217',
      'breadsheet-dev-auto-20261104-0217',
      'breadsheet-dev-auto-20261101-0217',
      'breadsheet-dev-auto-20261028-0217',
    ]);
  });

  test('counts only available snapshots towards the kept two, and never prunes one still creating', () => {
    const list = [
      auto('20261108-0217', '2026-11-08T02:17:00Z', { status: 'creating' }),
      auto('20261104-0217', '2026-11-04T02:17:00Z', { status: 'failed' }),
      auto('20261101-0217', '2026-11-01T02:17:00Z'),
      auto('20261028-0217', '2026-10-28T02:17:00Z'),
      auto('20261025-0217', '2026-10-25T02:17:00Z'),
    ];
    assert.deepEqual(snapshotsToPrune(list), [
      'breadsheet-dev-auto-20261104-0217',
      'breadsheet-dev-auto-20261025-0217',
    ]);
  });

  test('refuses to prune the snapshot this run just took', () => {
    assert.throws(
      () => snapshotsToPrune(snapshots, { mustKeep: 'breadsheet-dev-auto-20261028-0217' }),
      /Refusing to prune/,
    );
    assert.doesNotThrow(() => snapshotsToPrune(snapshots, { mustKeep: 'breadsheet-dev-auto-20261108-0217' }));
  });

  test('lists the manual snapshots it leaves alone, newest first', () => {
    assert.deepEqual(
      lingeringManualSnapshots(snapshots).map((s) => s.id),
      ['breadsheet-dev-pause-2026-11-02', 'breadsheet-dev-pause-2026-08-04', 'breadsheet-dev-auto-20260101-0000'],
    );
  });
});

describe('pickResumeSnapshot', () => {
  test('picks the newest available snapshot of either kind, with its image tag', () => {
    const s = pickResumeSnapshot([
      auto('20261104-0217', '2026-11-04T02:17:00Z'),
      auto('20261108-0217', '2026-11-08T02:17:00Z', { status: 'creating' }),
      snap('breadsheet-dev-pause-2026-08-04', '2026-08-04T10:00:00Z'),
      snap('some-other-snapshot', '2026-12-01T00:00:00Z'),
    ]);
    assert.deepEqual(s, {
      id: 'breadsheet-dev-auto-20261104-0217',
      image: 'ghcr.io/x/y:breadsheet-dev-auto-20261104-0217',
      createdAt: '2026-11-04T02:17:00Z',
    });
  });

  test('returns image null for a manual snapshot without an image tag', () => {
    const s = pickResumeSnapshot([snap('breadsheet-dev-pause-2026-11-07', '2026-11-07T10:00:00Z')]);
    assert.equal(s.id, 'breadsheet-dev-pause-2026-11-07');
    assert.equal(s.image, null);
  });

  test('returns null when there is nothing to resume from', () => {
    assert.equal(pickResumeSnapshot([]), null);
  });
});

test('snapshotId is UTC to the minute and uses only letters, digits and hyphens', () => {
  const id = snapshotId(new Date('2026-11-08T02:17:43Z'));
  assert.equal(id, 'breadsheet-dev-auto-20261108-0217');
  assert.match(id, /^[A-Za-z][A-Za-z0-9-]*$/);
});

describe('CLI', () => {
  const cli = join(here, 'dev-teardown.mjs');
  const run = (args, env = {}) =>
    spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  const dir = mkdtempSync(join(tmpdir(), 'dev-teardown-'));

  test('gate writes action and dry_run to $GITHUB_OUTPUT and fails on an unset mode', () => {
    const inst = join(dir, 'instance.json');
    writeFileSync(inst, JSON.stringify({ DBInstances: [instanceUpFor(80)] }));
    const out = join(dir, 'gh-output');
    writeFileSync(out, '');

    const ok = run(['gate', '--instance-json', inst, '--now', NOW.toISOString()], { DEV_AUTO_TEARDOWN: 'dry-run', GITHUB_OUTPUT: out });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(readFileSync(out, 'utf8'), 'action=teardown\ndry_run=true\n');

    const unset = run(['gate', '--instance-json', 'none']);
    assert.equal(unset.status, 1);
    assert.match(unset.stdout, /DEV_AUTO_TEARDOWN is not set/);
  });

  test('assert-plan exits non-zero on a bad plan and zero on the expected one', () => {
    assert.equal(run(['assert-plan', '--plan-json', join(here, 'fixtures', 'tier3-plan.ok.json')]).status, 0);
    const bad = run(['assert-plan', '--plan-json', join(here, 'fixtures', 'tier3-plan.replace.json')]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /refusing to continue/);
  });

  test('an unknown command exits 2', () => {
    assert.equal(run(['destroy-everything']).status, 2);
  });
});
