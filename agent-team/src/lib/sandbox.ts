import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalSandbox } from '@mastra/core/workspace';

// OS-level shell hardening. Verified experimentally (2026-08) against a real worktree that
// physical LocalFilesystem containment (basePath) only covers file *tools* — a shell command
// via execute_command can reach anywhere on the host, unrestricted, which is how an agent run
// ended up committing changes to .claude/agents/dev-reviewer.md and
// agent-team/src/agents/reviewer-agent.ts (files outside every pillar) during a real ticket.
// `isolation: 'bwrap'` closes that: writes outside the allowed paths never reach the real
// filesystem, even though the shell command reports success (bwrap gives the sandboxed process
// its own ephemeral view — verified by writing a file, seeing exit 0, and confirming on the
// real host disk the file never existed).
//
// Mirrors @mastra/core's internal buildBwrapCommand default construction (see
// node_modules/@mastra/core/dist/workspace-*.js) plus two fixes Mastra's own builder is
// missing, found by testing against a real project rather than trusting the docs:
//   1. No /dev at all by default — breaks anything that touches /dev/null, which is most
//      tools (git chief among them: "could not open '/dev/null' for reading and writing").
//   2. `allowSystemBinaries` only binds process.execPath's own bin/ directory. Under a version
//      manager (nvm, volta, asdf, ...) npm is a symlink from bin/ into a sibling
//      lib/node_modules/npm/, which isn't visible unless the whole version directory is bound.
//
// Passing `bwrapArgs` to LocalSandbox REPLACES Mastra's whole default construction rather than
// extending it (see buildBwrapCommand: `if (config.bwrapArgs?.length) return only those args`),
// so this has to duplicate the default faithfully rather than layer on top of it. Revisit/
// delete this the day @mastra/core's bwrap builder handles /dev and version-manager installs
// itself.
const DEFAULT_READONLY_BINDS = [
  '/usr',
  '/lib',
  '/lib64',
  '/bin',
  '/sbin',
  '/etc/alternatives',
  '/etc/ssl',
  '/etc/ca-certificates',
  '/etc/resolv.conf',
  '/etc/hosts',
  '/etc/passwd',
  '/etc/group',
  '/etc/nsswitch.conf',
  '/etc/ld.so.cache',
  '/etc/localtime',
];

function buildBwrapArgsWithDev(opts: {
  workspacePath: string;
  readOnlyPaths?: string[];
  readWritePaths?: string[];
  allowNetwork?: boolean;
}): string[] {
  const args: string[] = ['--unshare-pid', '--unshare-ipc', '--unshare-uts'];
  if (!opts.allowNetwork) args.push('--unshare-net');
  args.push('--proc', '/proc');
  args.push('--tmpfs', '/tmp');
  args.push('--dev-bind', '/dev', '/dev');
  for (const p of DEFAULT_READONLY_BINDS) args.push('--ro-bind-try', p, p);
  const nodeVersionDir = path.dirname(path.dirname(process.execPath));
  if (!DEFAULT_READONLY_BINDS.some((p) => nodeVersionDir.startsWith(p))) {
    args.push('--ro-bind', nodeVersionDir, nodeVersionDir);
  }
  args.push('--ro-bind-try', '/opt', '/opt');
  args.push('--ro-bind-try', '/snap', '/snap');
  args.push('--bind', opts.workspacePath, opts.workspacePath);
  for (const p of opts.readWritePaths ?? []) args.push('--bind', p, p);
  // Read-only binds MUST come after the read-write ones: bwrap applies binds in order, so a
  // later `--bind` of a parent directory re-exposes anything an earlier `--ro-bind` covered
  // inside it. The reviewer's workspace is the worktree root, which contains the worktree's
  // `.git` pointer file — writable under the old ordering, which let a sandboxed command point
  // `gitdir:` at a git directory it controls (with e.g. `core.fsmonitor` set) and have the
  // coordinator's *unsandboxed* `git status`/`add`/`commit` execute it on the host.
  for (const p of opts.readOnlyPaths ?? []) args.push('--ro-bind', p, p);
  args.push('--chdir', opts.workspacePath);
  args.push('--die-with-parent');
  return args;
}

/**
 * Persistent, agent-only cache directory, bound read-write into every sandbox so npm stops
 * starting cold on every run (with no bound HOME, each sandboxed command used to get a fresh,
 * empty home on bwrap's ephemeral root). Deliberately NOT the user's real `~/.cache` or `~/.npm`:
 * nothing a sandboxed command writes here can touch host tool state. The sandbox's `HOME`
 * points inside it as well.
 */
function agentCacheDir(): string {
  const dir = path.join(os.homedir(), '.cache', 'bread-sheet-agent-team');
  for (const sub of ['home', 'npm', 'xdg']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  return dir;
}

/**
 * The sandbox's whole environment, on top of the host `PATH` Mastra always adds (see
 * LocalSandbox.buildEnv). Mastra passes nothing else from `process.env`, so the API keys
 * `config.ts` loads from agent-team/.env never reach agent commands — keep it that way: add only
 * non-secret, tool-location variables here.
 */
function sandboxEnv(cacheDir: string): NodeJS.ProcessEnv {
  return {
    HOME: path.join(cacheDir, 'home'),
    LANG: 'C.UTF-8',
    npm_config_cache: path.join(cacheDir, 'npm'),
    XDG_CACHE_HOME: path.join(cacheDir, 'xdg'),
  };
}

let loggedFallback = false;

/**
 * Builds the isolation/nativeSandbox portion of a `LocalSandbox` config, hardened when
 * possible. Falls back to no isolation (today's unrestricted shell) on anything other than
 * Linux+bwrap — seatbelt (macOS) hasn't been tested against this repo and shouldn't be
 * silently assumed safe. `readOnlyPaths` is typically the worktree's own `.git` pointer plus
 * the main checkout's `.git`, so `git status`/`diff`/`log` still work — see coordinator.ts,
 * which now owns every git *write* (add/commit/push) so agents never need write access there.
 * They are bound last, so they stay read-only even when they sit inside `workspacePath`.
 *
 * No per-command timeout is set: @mastra/core 1.64's LocalSandbox declares a `timeout` option
 * (documented as defaulting to 30 s) but never reads it, so a command only times out when the
 * model passes `timeout` to execute_command itself.
 */
export function hardenedSandbox(opts: {
  workspacePath: string;
  readOnlyPaths?: string[];
  allowNetwork?: boolean;
}): LocalSandbox {
  const cacheDir = agentCacheDir();
  const env = sandboxEnv(cacheDir);
  const detection = LocalSandbox.detectIsolation();
  if (os.platform() !== 'linux' || detection.backend !== 'bwrap' || !detection.available) {
    if (!loggedFallback) {
      loggedFallback = true;
      console.warn(
        `[sandbox] No verified OS-level isolation available on this platform (${detection.backend}, ` +
          `available=${detection.available}) — shell commands are unrestricted, same as before ` +
          `this hardening was added. See agent-team/src/lib/sandbox.ts.`,
      );
    }
    return new LocalSandbox({ workingDirectory: opts.workspacePath, env });
  }
  return new LocalSandbox({
    workingDirectory: opts.workspacePath,
    env,
    isolation: 'bwrap',
    nativeSandbox: {
      bwrapArgs: buildBwrapArgsWithDev({
        workspacePath: opts.workspacePath,
        allowNetwork: opts.allowNetwork ?? true,
        readOnlyPaths: opts.readOnlyPaths,
        readWritePaths: [cacheDir],
      }),
    },
  });
}
