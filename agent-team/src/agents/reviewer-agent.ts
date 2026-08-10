import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent } from '@mastra/core/agent';
import {
  Workspace,
  LocalFilesystem,
  LocalSandbox,
  WORKSPACE_TOOLS,
  type WorkspaceToolHookContext,
  type WorkspaceToolBeforeHookResult,
} from '@mastra/core/workspace';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const guardrails = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'guardrails.md'), 'utf8');

// The reviewer is the merge gate and must not silently patch application code — see the
// "reviewer is read/test-only on app code" rule in guardrails.md. Enforced here, not just by
// instruction: any workspace tool that can create/change/remove a file is intercepted and
// rejected unless the target path is under docs/ or is FEATURES.md itself.
const WRITE_TOOL_NAMES = new Set<string>([
  WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.MKDIR,
  WORKSPACE_TOOLS.FILESYSTEM.DELETE,
  WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT,
]);

function isAllowedReviewerWritePath(targetPath: string): boolean {
  const normalized = targetPath.replace(/^\.\//, '').replace(/^\/+/, '');
  return normalized === 'FEATURES.md' || normalized.startsWith('docs/');
}

function beforeToolCall(
  ctx: WorkspaceToolHookContext,
): void | WorkspaceToolBeforeHookResult {
  if (!WRITE_TOOL_NAMES.has(ctx.workspaceToolName)) return;

  const targetPath = (ctx.input as { path?: unknown })?.path;
  if (typeof targetPath !== 'string' || !isAllowedReviewerWritePath(targetPath)) {
    return {
      proceed: false,
      output: {
        error:
          `Refused: the reviewer role may only write within docs/ or FEATURES.md, ` +
          `got path "${String(targetPath)}". Report this as a finding instead of editing it.`,
      },
    };
  }
}

export function createReviewerAgent({
  model,
  worktreePath,
  baseBranch,
  environmentFacts,
}: {
  model: string;
  worktreePath: string;
  baseBranch: string;
  environmentFacts: string;
}) {
  const workspace = new Workspace({
    filesystem: new LocalFilesystem({ basePath: worktreePath }),
    sandbox: new LocalSandbox({ workingDirectory: worktreePath }),
    tools: {
      hooks: { beforeToolCall },
    },
  });

  return new Agent({
    id: 'dev-reviewer',
    name: 'BreadSheet Dev Team Reviewer',
    model,
    workspace,
    instructions: `${guardrails}

---

You are the **reviewer** role — the merge gate. Your workspace is rooted at the ticket's
worktree root, so you can read and run commands anywhere in the repo, but a hook rejects every
write/edit/mkdir/delete call whose path isn't under \`docs/\` or exactly \`FEATURES.md\`. If you
find a bug in the implementation, write it into the findings doc — you cannot fix it yourself,
by design.

This run's base branch is \`${baseBranch}\` — use it wherever these instructions say "main"
below (diffing, and the PR base).

${environmentFacts}

Your task prompt may include a "COORDINATOR SCOPE CHECK" line — that's an objective,
coordinator-computed list of changed files that fall outside every pillar invoked for this
ticket (computed from \`git diff\`/\`git status\`, not from the implementer's self-report). It
is a flag to verify, not an automatic fail: confirm whether those files are actually in scope
before deciding \`PASS\`/\`BLOCKED\`.

Working procedure:
1. Read the ticket and its acceptance criteria in \`FEATURES.md\`, and run
   \`git diff ${baseBranch}...HEAD\` to see the full implementer diff.
2. Run the full test matrix via the shell tool:
   - \`server\`: \`npm --prefix server run typecheck\`, \`npm --prefix server test\` (if backend
     touched)
   - \`bread-sheet-app\`: \`npm --prefix bread-sheet-app run typecheck\`,
     \`npm --prefix bread-sheet-app run lint\`, \`npm --prefix bread-sheet-app test\` (if
     frontend touched)
   - \`npm --prefix bread-sheet-app run test:e2e\` for any change reachable through the UI
3. Walk the acceptance criteria one item at a time against the diff and the test output —
   green tests are necessary, not sufficient.
4. Verify \`CLAUDE.md\`'s "Mandatory Post-Implementation Steps" were honored: relevant
   \`docs/architecture/*.md\` updated, an ADR added if architecturally significant,
   \`docs/bruno/*.bru\` updated for endpoint changes.
5. Write \`docs/<TICKET-ID>-findings.md\`, matching the shape of
   \`docs/P5-003-implementation-plan.md\`: current state, what was implemented, test results
   (key pass/fail summary, not full logs), open questions.
6. **On pass:** check the ticket's boxes in \`FEATURES.md\`, commit, then run
   \`gh pr create --base ${baseBranch} --head agent/<TICKET-ID> --title "..." --body "..."\`
   referencing the ticket and the findings doc. Never merge it.
7. **On fail:** do not open a PR. Mark the findings doc \`BLOCKED\` with concrete, specific open
   questions. Commit the doc.
8. Your final turn is validated against a structured schema (the coordinator reads it
   programmatically, not by re-parsing your prose, so get \`status\` right — it's the only
   thing that decides whether a fix cycle happens): \`status\` is \`PASS\` only when you
   actually opened the PR, \`prUrl\` is set only then, \`findingsDocPath\` is always the doc you
   wrote, \`testMatrix\` reflects what you actually ran (\`not_run\` for anything skipped because
   the ticket didn't touch that pillar), and \`openQuestions\` must be concrete and non-empty
   whenever \`status\` is \`BLOCKED\` — that's what the next fix cycle is handed.`,
  });
}
