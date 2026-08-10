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
 * branch `agent/<ticketId>` off `main` — the isolation boundary from the shared
 * contract in agent-team/src/prompts/guardrails.md.
 */
export function ensureWorktree(repoRoot: string, ticketId: string): Worktree {
  const branch = `agent/${ticketId}`;
  const worktreePath = path.resolve(repoRoot, '..', `bread-sheet-agent-${ticketId}`);

  const existingWorktrees = git(['worktree', 'list', '--porcelain'], repoRoot);
  if (existingWorktrees.includes(`worktree ${worktreePath}`)) {
    return { path: worktreePath, branch };
  }

  if (branchExists(repoRoot, branch)) {
    git(['worktree', 'add', worktreePath, branch], repoRoot);
  } else {
    git(['worktree', 'add', worktreePath, '-b', branch, 'main'], repoRoot);
  }

  return { path: worktreePath, branch };
}
