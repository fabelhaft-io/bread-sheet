import { z } from 'zod';

// The typed contract between coordinator and agents. Mastra validates the implementer's/
// reviewer's final turn against these schemas (agent.generate(..., { structuredOutput }))
// instead of the coordinator regex-matching prose for a magic word like "BLOCKED" — see
// docs/architecture/agent-dev-team.md's "Typed handoff" section for why.
const checkResult = z.enum(['pass', 'fail', 'not_run']);

export const implementerHandoffSchema = z.object({
  status: z.enum(['DONE', 'BLOCKED']),
  filesChanged: z
    .array(z.string())
    .describe('Repo-relative paths (from the worktree root) of every file added/modified/deleted.'),
  testResults: z.object({
    typecheck: checkResult,
    lint: checkResult,
    unitTests: checkResult,
  }),
  summary: z.string().describe('One-paragraph human-readable summary of what changed and why.'),
  openQuestions: z
    .array(z.string())
    .describe('Ambiguities or out-of-scope findings — never silently guessed at or fixed. Empty array if none.'),
});
export type ImplementerHandoff = z.infer<typeof implementerHandoffSchema>;

export const reviewerHandoffSchema = z.object({
  status: z.enum(['PASS', 'BLOCKED']),
  findingsDocPath: z.string().describe('Repo-relative path to the findings doc this review wrote.'),
  prUrl: z.string().optional().describe('Set only when status is PASS and a PR was opened.'),
  testMatrix: z.object({
    serverTypecheck: checkResult,
    serverTests: checkResult,
    appTypecheck: checkResult,
    appLint: checkResult,
    appTests: checkResult,
    e2eTests: checkResult,
  }),
  openQuestions: z
    .array(z.string())
    .describe('Required when status is BLOCKED — what specifically needs to change. Empty array when PASS.'),
});
export type ReviewerHandoff = z.infer<typeof reviewerHandoffSchema>;

const PILLAR_PREFIX = { frontend: 'bread-sheet-app/', backend: 'server/' } as const;

export interface InvokedPillars {
  frontend: boolean;
  backend: boolean;
}

/**
 * Objective, coordinator-computed cross-check — doesn't trust the implementers' self-reported
 * `filesChanged` at all. Physical filesystem containment (see frontend-agent.ts/backend-agent.ts)
 * already stops file-tool writes outside a pillar; this catches the one thing containment
 * can't: a shell command reaching outside it (e.g. `echo x > ../server/foo.ts`), and also
 * flags anything outside *every* invoked pillar (e.g. an unexpected terraform/ or docs/ edit
 * at implementation time — the reviewer is the one allowed to touch docs/).
 */
export function findOutOfPillarFiles(changedFiles: string[], invokedPillars: InvokedPillars): string[] {
  const allowedPrefixes = (Object.keys(invokedPillars) as (keyof InvokedPillars)[])
    .filter((pillar) => invokedPillars[pillar])
    .map((pillar) => PILLAR_PREFIX[pillar]);
  return changedFiles.filter((f) => !allowedPrefixes.some((prefix) => f.startsWith(prefix)));
}
