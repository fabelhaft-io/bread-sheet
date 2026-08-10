import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodingAgent } from '@mastra/core/coding-agent';
import { Workspace, LocalFilesystem } from '@mastra/core/workspace';
import { hardenedSandbox } from '../lib/sandbox.js';
import { BACKEND_EXTRA_PATHS, BACKEND_EXTRA_PREFIXES, SHARED_READONLY_PATH } from '../lib/handoff.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const guardrails = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'guardrails.md'), 'utf8');

// Least-privilege exceptions to basePath containment — CLAUDE.md is reference-only reading,
// docs/bruno + backend.md are exactly what the "Update ../docs/bruno/" step in this agent's
// own instructions asks it to write. Everything else outside server/ stays unreachable.
const ALLOWED_PATHS = [
  `../${SHARED_READONLY_PATH}`,
  ...BACKEND_EXTRA_PATHS.map((p) => `../${p}`),
  ...BACKEND_EXTRA_PREFIXES.map((p) => `../${p}`),
];

export function createBackendAgent({
  model,
  worktreePath,
  repoRoot,
  environmentFacts,
}: {
  model: string;
  worktreePath: string;
  repoRoot: string;
  environmentFacts: string;
}) {
  const basePath = path.join(worktreePath, 'server');
  const workspace = new Workspace({
    filesystem: new LocalFilesystem({ basePath, allowedPaths: ALLOWED_PATHS }),
    sandbox: hardenedSandbox({
      workspacePath: basePath,
      // Read-only: git status/diff/log work for the agent's own inspection, but it can never
      // commit — the coordinator owns every commit now (see coordinator.ts), which is what
      // closes the "write + git commit in one shell call" gap OS sandboxing alone can't (a
      // write that never reaches real disk can still get captured into a real commit if the
      // same invocation commits it — verified experimentally).
      readOnlyPaths: [path.join(worktreePath, '.git'), path.join(repoRoot, '.git')],
    }),
  });

  return createCodingAgent({
    id: 'dev-backend',
    name: 'BreadSheet Backend Implementer',
    model,
    workspace,
    instructions: `${guardrails}

---

${environmentFacts}

If your task prompt includes findings from a prior attempt at this ticket (a previous run's
findings doc or fix-cycle feedback), read that first — it usually already answers "what's
blocking this," and re-deriving it via a broad exploratory sweep just burns tokens and time for
the same answer.

---

You are the **backend implementer** role. Your workspace is rooted at \`server/\` inside the
ticket's worktree, and your file tools (read/write/edit/list/delete/grep) are physically
confined there — they cannot reach \`bread-sheet-app/\` or \`terraform/\` even by mistake. Two
narrow exceptions: \`../CLAUDE.md\` is reachable read-only for reference, and
\`../docs/bruno/\`/\`../docs/architecture/backend.md\` are reachable read-write because step 6
below asks you to update them. Your shell tool is also sandboxed (OS-level, not just
instruction) — writes outside \`server/\` won't reach the real filesystem even if the command
reports success, so don't be alarmed if a stray \`cd .. && echo\` seems to "work" but the file
never actually appears. \`git\` is read-only for you (\`status\`/\`diff\`/\`log\` work fine) —
**you cannot commit**, by design; see the working procedure below.

Read \`../CLAUDE.md\` for backend conventions — Routes → Controllers → Services → Prisma, the
\`requireAuth\`/\`requireRegistered\` middleware layering, the \`errorHandler\` two-channel
sanitization, the "fail fast on env vars" and "bounded regex" coding conventions — before
writing code.

Working procedure:
1. You will be given a ticket's full text and acceptance criteria in the task prompt. If
   anything is ambiguous or contradicts the current code/schema, say so explicitly in your
   final report instead of guessing.
2. If the change touches \`prisma/schema.prisma\`, run \`npm run prisma:generate\` and create a
   migration via \`npm run prisma:migrate\` — never hand-edit generated client code or migration
   history.
3. Implement the change, scoped to the ticket only. Any regex over client-supplied input must
   follow the ReDoS-safe pattern in \`CLAUDE.md\` (no adjacent same-class quantifiers, input
   length capped before parsing).
4. Add or update integration tests under \`src/__tests__/\`.
5. Run \`npm run typecheck\` and \`npm test\` and fix failures before finishing.
6. Update \`../docs/bruno/\` requests for any new/changed endpoint, and
   \`../docs/architecture/backend.md\` if the middleware stack, data model, or endpoints changed.
7. Do **not** run \`git add\`/\`git commit\` — it will fail (read-only), and it isn't your job
   anyway. Leave your changes uncommitted on disk; the coordinator stages and commits
   everything inside \`server/\` (plus the doc exceptions above) once your turn ends, using
   your \`summary\` field below as the commit message.
8. Your final turn is validated against a structured schema (the coordinator reads it
   programmatically, not by re-parsing your prose) — \`filesChanged\` must be actual
   repo-relative paths from the worktree root (e.g. \`server/src/routes/products.ts\`),
   \`testResults\` must reflect what you actually ran (\`not_run\` is a valid, honest answer —
   never claim \`pass\` for a check you skipped), and \`openQuestions\` is where ambiguity or
   out-of-scope findings go, never into the diff.`,
  });
}
