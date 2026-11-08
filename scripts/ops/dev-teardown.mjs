#!/usr/bin/env node
// Decisions behind the scheduled Tier 3 teardown of the dev stack (TICKET-P9-009).
//
// The workflow (.github/workflows/dev-auto-teardown.yml) and scripts/dev-stack.sh do the
// plumbing — AWS CLI, Terraform. Everything that *decides* something lives here, as pure
// functions, so it can be tested without AWS: whether tonight's run tears down (`gate`), whether a saved
// destroy plan is exactly the expected cascade (`assertPlan`), which automatic snapshots to
// prune (`snapshotsToPrune`) and which snapshot a resume restores from (`pickResumeSnapshot`).
//
// Dependency-free on purpose: it runs on a bare runner and in `node --test` without an
// `npm ci`. See docs/architecture/infrastructure.md § Pausing / Resuming the Dev Stack.

import { readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const KEEP_AUTO_SNAPSHOTS = 2;
export const MODES = ['off', 'dry-run', 'on'];

export const AUTO_SNAPSHOT_PREFIX = 'breadsheet-dev-auto-';
export const PAUSE_SNAPSHOT_PREFIX = 'breadsheet-dev-pause-';
export const CREATED_BY_TAG = 'created-by';
export const CREATED_BY_VALUE = 'dev-auto-teardown';

// The exact Tier 3 cascade of `terraform plan -destroy -target=aws_db_instance.main`. When the
// cascade grows legitimately, change this list and the runbook table in infrastructure.md in the
// same PR — an unattended destroy must never delete something nobody listed.
export const EXPECTED_DESTROY_SET = Object.freeze([
  'aws_budgets_budget_action.stop_rds',
  'aws_db_instance.main',
  'aws_ecs_service.server',
  'aws_ecs_task_definition.server',
  'aws_iam_role_policy.ecs_task_rds_iam',
]);

const HOUR_MS = 3_600_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` of `date` in UTC. */
const utcDay = (date) => date.toISOString().slice(0, 10);

function parseIsoDate(value) {
  const m = ISO_DATE.exec(value);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  // Rejects 2026-02-30 and friends, which Date.UTC silently rolls over.
  return utcDay(d) === value ? value : null;
}

/**
 * The switches that need no AWS: the master `DEV_AUTO_TEARDOWN` mode and the
 * `DEV_KEEP_ALIVE_UNTIL` opt-out. Returns `{ action: 'fail' | 'skip' | 'continue', reason }`.
 *
 * An unset or unknown mode fails rather than defaulting: `off` would silently stop saving money,
 * `on` would silently start destroying things. A malformed keep-alive date fails for the same
 * reason — a typo must not read as "no keep-alive".
 */
export function switchGate({ mode, keepAliveUntil, now }) {
  const m = (mode ?? '').trim();
  if (m === '') {
    return {
      action: 'fail',
      reason:
        'DEV_AUTO_TEARDOWN is not set. Set it explicitly: ' +
        '`gh variable set DEV_AUTO_TEARDOWN --body off|dry-run|on`.',
    };
  }
  if (!MODES.includes(m)) {
    return {
      action: 'fail',
      reason: `DEV_AUTO_TEARDOWN is '${m}', expected one of ${MODES.join(' | ')}.`,
    };
  }
  if (m === 'off') return { action: 'skip', reason: 'DEV_AUTO_TEARDOWN=off — nothing to do.' };

  const keep = (keepAliveUntil ?? '').trim();
  if (keep !== '') {
    const day = parseIsoDate(keep);
    if (!day) {
      return {
        action: 'fail',
        reason: `DEV_KEEP_ALIVE_UNTIL is '${keep}', expected an ISO date (YYYY-MM-DD) or unset.`,
      };
    }
    if (utcDay(now) <= day) {
      return { action: 'skip', reason: `Kept alive until ${day} (DEV_KEEP_ALIVE_UNTIL).` };
    }
  }
  return { action: 'continue', reason: `DEV_AUTO_TEARDOWN=${m}.` };
}

/** Whole hours and minutes, for log lines. */
function formatDuration(ms) {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return `${h} h ${String(min).padStart(2, '0')} min`;
}

/**
 * The full teardown decision for one nightly run: if the stack is running, tear it down, unless a
 * switch says otherwise. There is deliberately no minimum uptime. Dev is a daytime tool, and
 * `DEV_KEEP_ALIVE_UNTIL` is the way to keep it up overnight.
 *
 * `instance` is the `DBInstances[0]` object from `aws rds describe-db-instances`, or `null` when
 * the instance does not exist (the stack is already paused). Uptime, from `InstanceCreateTime`
 * (every Tier 3 resume re-creates the instance, so that is the last resume), is only reported.
 *
 * Returns `{ action: 'fail' | 'skip' | 'teardown', dryRun, reason, uptimeHours? }`.
 */
export function gate({ mode, keepAliveUntil, instance, now, dryRun = false }) {
  const sw = switchGate({ mode, keepAliveUntil, now });
  if (sw.action !== 'continue') return { ...sw, dryRun: false };

  const isDryRun = dryRun || mode.trim() === 'dry-run';

  if (instance == null) {
    return { action: 'skip', dryRun: isDryRun, reason: 'Dev stack is already paused (RDS instance not found).' };
  }
  const created = new Date(instance.InstanceCreateTime);
  if (Number.isNaN(created.getTime())) {
    return {
      action: 'fail',
      dryRun: isDryRun,
      reason: `RDS instance has no parsable InstanceCreateTime ('${instance.InstanceCreateTime}').`,
    };
  }
  const upMs = now.getTime() - created.getTime();
  return {
    action: 'teardown',
    dryRun: isDryRun,
    uptimeHours: upMs / HOUR_MS,
    reason: `Running (up for ${formatDuration(upMs)}) — teardown due.`,
  };
}

/**
 * Checks a `terraform show -json` rendering of the saved destroy plan. Every resource change must
 * be a plain `delete` and the set of addresses must be exactly `expected`. Pure no-ops are ignored
 * (they change nothing); anything else — a replace, an update, a create, a deposed object, an
 * address nobody listed, or a listed address that is missing — is a failure.
 *
 * Returns `{ ok, errors, addresses }`.
 */
export function assertPlan(plan, expected = EXPECTED_DESTROY_SET) {
  const errors = [];
  if (plan == null || typeof plan !== 'object') {
    return { ok: false, errors: ['Plan JSON is empty or not an object.'], addresses: [] };
  }
  if (plan.errored === true) errors.push('Terraform reports the plan as errored.');

  const changes = Array.isArray(plan.resource_changes) ? plan.resource_changes : [];
  const seen = new Set();
  for (const rc of changes) {
    const actions = rc?.change?.actions ?? [];
    if (actions.length === 1 && actions[0] === 'no-op') continue;

    const label = rc.deposed ? `${rc.address} (deposed ${rc.deposed})` : rc.address;
    if (rc.deposed) {
      errors.push(`${label}: deposed object in the plan — resolve it by hand before automating a destroy.`);
      continue;
    }
    if (!(actions.length === 1 && actions[0] === 'delete')) {
      errors.push(`${label}: planned actions are [${actions.join(', ')}], expected [delete].`);
    }
    if (!expected.includes(rc.address)) {
      errors.push(`${label}: not in the expected Tier 3 cascade.`);
    }
    if (seen.has(rc.address)) errors.push(`${label}: appears more than once.`);
    seen.add(rc.address);
  }
  for (const addr of expected) {
    if (!seen.has(addr)) errors.push(`${addr}: expected in the Tier 3 cascade but not in the plan.`);
  }
  return { ok: errors.length === 0, errors, addresses: [...seen].sort() };
}

const tagValue = (snapshot, key) =>
  (snapshot.TagList ?? []).find((t) => t.Key === key)?.Value;

const byCreateTimeDesc = (a, b) =>
  new Date(b.SnapshotCreateTime ?? 0).getTime() - new Date(a.SnapshotCreateTime ?? 0).getTime();

/**
 * An automatic snapshot is one this workflow created: the id prefix **and** the tag both match.
 * The IAM policy on the teardown role applies the same two conditions independently, so a manual
 * `breadsheet-dev-pause-*` snapshot is excluded twice over.
 */
export const isAutoSnapshot = (s) =>
  typeof s.DBSnapshotIdentifier === 'string' &&
  s.DBSnapshotIdentifier.startsWith(AUTO_SNAPSHOT_PREFIX) &&
  tagValue(s, CREATED_BY_TAG) === CREATED_BY_VALUE;

/**
 * Automatic snapshots beyond the newest `keep` **available** ones, oldest last. Snapshots still
 * `creating` are never pruned. `mustKeep` (the snapshot this run just took) is an assertion: if
 * the selection would prune it, this throws rather than deleting the only fresh copy.
 */
export function snapshotsToPrune(snapshots, { keep = KEEP_AUTO_SNAPSHOTS, mustKeep } = {}) {
  const auto = snapshots.filter(isAutoSnapshot).sort(byCreateTimeDesc);
  const kept = auto.filter((s) => s.Status === 'available').slice(0, keep);
  const keptIds = new Set(kept.map((s) => s.DBSnapshotIdentifier));
  if (mustKeep && !keptIds.has(mustKeep)) {
    throw new Error(`Refusing to prune: ${mustKeep} is not among the newest ${keep} available automatic snapshots.`);
  }
  return auto
    .filter((s) => !keptIds.has(s.DBSnapshotIdentifier) && s.Status !== 'creating')
    .map((s) => s.DBSnapshotIdentifier);
}

/** Manual snapshots this workflow never touches (e.g. `breadsheet-dev-pause-*`), newest first. */
export const lingeringManualSnapshots = (snapshots) =>
  snapshots.filter((s) => !isAutoSnapshot(s)).sort(byCreateTimeDesc).map((s) => ({
    id: s.DBSnapshotIdentifier,
    createdAt: s.SnapshotCreateTime,
    status: s.Status,
  }));

/**
 * The snapshot a resume restores from: the newest `available` one of either kind (automatic or
 * manual pause). Returns `{ id, image, createdAt }` — `image` is the snapshot's `image` tag, or
 * `null` for a manual snapshot taken without one (the resume then needs `--image`).
 */
export function pickResumeSnapshot(snapshots) {
  const candidates = snapshots
    .filter(
      (s) =>
        s.Status === 'available' &&
        (s.DBSnapshotIdentifier?.startsWith(AUTO_SNAPSHOT_PREFIX) ||
          s.DBSnapshotIdentifier?.startsWith(PAUSE_SNAPSHOT_PREFIX)),
    )
    .sort(byCreateTimeDesc);
  if (candidates.length === 0) return null;
  const s = candidates[0];
  return { id: s.DBSnapshotIdentifier, image: tagValue(s, 'image') ?? null, createdAt: s.SnapshotCreateTime };
}

/**
 * `breadsheet-dev-auto-YYYYMMDD-HHMM`, UTC. Minutes in the id so a dispatched second run on the same
 * day doesn't collide. Snapshot ids allow only letters, digits and hyphens, which is why the
 * image lives in a tag rather than here.
 */
export function snapshotId(now) {
  const iso = now.toISOString(); // 2026-11-08T02:17:43.000Z
  return `${AUTO_SNAPSHOT_PREFIX}${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}`;
}

// ─────────────────────────────── CLI ────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`Unexpected argument '${a}'.`);
    const eq = a.indexOf('=');
    if (eq !== -1) args[a.slice(2, eq)] = a.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) args[a.slice(2)] = argv[++i];
    else args[a.slice(2)] = 'true';
  }
  return args;
}

const readJson = (path) => JSON.parse(readFileSync(path === '-' ? 0 : path, 'utf8'));
const bool = (v) => v === 'true' || v === '1';
const nowFrom = (args) => (args.now ? new Date(args.now) : new Date());

/** Writes `key=value` lines to $GITHUB_OUTPUT when running in Actions; no-op elsewhere. */
function ghOutput(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(''),
  );
}

/** The `DBInstances[0]` of a describe-db-instances response file, or null for "not found". */
function instanceFrom(args) {
  if (args['instance-json'] === undefined) throw new Error('--instance-json <file|-> is required.');
  if (args['instance-json'] === 'none') return null;
  const json = readJson(args['instance-json']);
  return json?.DBInstances?.[0] ?? null;
}

const snapshotsFrom = (args) => {
  if (!args['snapshots-json']) throw new Error('--snapshots-json <file|-> is required.');
  return readJson(args['snapshots-json']).DBSnapshots ?? [];
};

const COMMANDS = {
  // Mode + keep-alive only — runs before any AWS credentials exist.
  switches(args) {
    const d = switchGate({ mode: process.env.DEV_AUTO_TEARDOWN, keepAliveUntil: process.env.DEV_KEEP_ALIVE_UNTIL, now: nowFrom(args) });
    console.log(d.reason);
    ghOutput({ action: d.action });
    return d.action === 'fail' ? 1 : 0;
  },

  gate(args) {
    const d = gate({
      mode: process.env.DEV_AUTO_TEARDOWN,
      keepAliveUntil: process.env.DEV_KEEP_ALIVE_UNTIL,
      instance: instanceFrom(args),
      now: nowFrom(args),
      dryRun: bool(args['dry-run']),
    });
    if (args.json === 'true') console.log(JSON.stringify(d));
    else console.log(d.reason);
    ghOutput({ action: d.action, dry_run: String(d.dryRun) });
    return d.action === 'fail' ? 1 : 0;
  },

  'assert-plan'(args) {
    if (!args['plan-json']) throw new Error('--plan-json <file|-> is required.');
    const r = assertPlan(readJson(args['plan-json']));
    if (r.ok) {
      console.log(`Plan matches the expected Tier 3 cascade (${r.addresses.length} deletes):`);
      for (const a of r.addresses) console.log(`  - ${a}`);
      return 0;
    }
    console.error('Plan does NOT match the expected Tier 3 cascade — refusing to continue:');
    for (const e of r.errors) console.error(`  ✗ ${e}`);
    console.error(`Expected exactly these deletes: ${EXPECTED_DESTROY_SET.join(', ')}`);
    return 1;
  },

  prune(args) {
    const ids = snapshotsToPrune(snapshotsFrom(args), {
      keep: args.keep ? Number(args.keep) : KEEP_AUTO_SNAPSHOTS,
      mustKeep: args['must-keep'],
    });
    for (const id of ids) console.log(id);
    return 0;
  },

  'manual-snapshots'(args) {
    console.log(JSON.stringify(lingeringManualSnapshots(snapshotsFrom(args))));
    return 0;
  },

  'resume-snapshot'(args) {
    const s = pickResumeSnapshot(snapshotsFrom(args));
    if (!s) {
      console.error('No available breadsheet-dev-auto-* or breadsheet-dev-pause-* snapshot found.');
      return 1;
    }
    console.log(JSON.stringify(s));
    return 0;
  },

  'snapshot-id'(args) {
    console.log(snapshotId(nowFrom(args)));
    return 0;
  },
};

export function main(argv) {
  const [cmd, ...rest] = argv;
  const run = COMMANDS[cmd];
  if (!run) {
    console.error(`usage: dev-teardown.mjs <${Object.keys(COMMANDS).join('|')}> [--flags]`);
    return 2;
  }
  return run(parseArgs(rest));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
