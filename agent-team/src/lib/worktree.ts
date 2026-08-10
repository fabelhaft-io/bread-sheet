import { execFileSync } from 'node:child_process';
import path from 'node:path';

export interface Worktree {
  path: string;
  branch: string;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function branchExists(repoRoot: string, branch: string): boolean {
  try {
    git(['rev-parse', '--verify', '--quiet', branch], repoRoot);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates (or reuses, for a resumed BLOCKED run) the ticket's dedicated worktree on
 * branch `agent/<ticketId>` off `baseBranch` — the isolation boundary from the shared
 * contract in agent-team/src/prompts/guardrails.md.
 *
 * `baseBranch` defaults to `main` (see config.ts's BASE_BRANCH), which is correct once
 * this orchestrator itself has landed on `main`. Until then, point it at whichever
 * branch actually has agent-team/ + the ticket, or every spawned agent starts in a
 * worktree missing its own instructions.
 */
export function ensureWorktree(repoRoot: string, ticketId: string, baseBranch: string): Worktree {
  const branch = `agent/${ticketId}`;
  const worktreePath = path.resolve(repoRoot, '..', `bread-sheet-agent-${ticketId}`);

  const existingWorktrees = git(['worktree', 'list', '--porcelain'], repoRoot);
  if (existingWorktrees.includes(`worktree ${worktreePath}`)) {
    return { path: worktreePath, branch };
  }

  if (branchExists(repoRoot, branch)) {
    git(['worktree', 'add', worktreePath, branch], repoRoot);
  } else {
    git(['worktree', 'add', worktreePath, '-b', branch, baseBranch], repoRoot);
  }

  return { path: worktreePath, branch };
}

/**
 * The objective (not model-reported) list of files changed on the ticket branch so far,
 * relative to the worktree root — used by handoff.ts's findOutOfPillarFiles to cross-check
 * an implementer's self-reported filesChanged against what actually happened on disk.
 * Includes uncommitted changes (git diff has no commit yet to compare when an agent hasn't
 * committed), so this is `diff <base>...HEAD` plus working-tree status, deduped.
 */
export function getChangedFiles(worktreePath: string, baseBranch: string): string[] {
  const committed = git(['diff', '--name-only', `${baseBranch}...HEAD`], worktreePath)
    .split('\n')
    .filter(Boolean);
  const uncommitted = git(['status', '--porcelain'], worktreePath)
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).trim());
  return [...new Set([...committed, ...uncommitted])];
}
