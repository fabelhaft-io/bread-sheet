import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { findTicket, type Ticket } from './lib/tickets.js';
import { ensureWorktree, getChangedFiles } from './lib/worktree.js';
import { logAgentProgress } from './lib/progress.js';
import { probeEnvironment, formatEnvironmentFacts } from './lib/environment.js';
import { createFrontendAgent } from './agents/frontend-agent.js';
import { createBackendAgent } from './agents/backend-agent.js';
import { createReviewerAgent } from './agents/reviewer-agent.js';
import {
  implementerHandoffSchema,
  reviewerHandoffSchema,
  findOutOfPillarFiles,
  type ImplementerHandoff,
  type ReviewerHandoff,
  type InvokedPillars,
} from './lib/handoff.js';

const MAX_FIX_CYCLES = 2;
const MAX_STEPS = 60;
const MAX_PRIOR_FINDINGS_CHARS = 6000;

export interface CoordinatorResult {
  ok: boolean;
  summary: string;
}

/**
 * Best-effort heuristic, same as the Claude Code coordinator skill: when genuinely
 * unsure, run both implementers rather than guess wrong and silently skip a pillar.
 */
function detectPillars(ticket: Ticket): InvokedPillars {
  const text = `${ticket.heading}\n${ticket.body}`.toLowerCase();
  const mentionsFrontend = /bread-sheet-app|frontend|screen|ui\b|expo/.test(text);
  const mentionsBackend = /server\/|backend|endpoint|api\b|prisma|controller|service/.test(text);
  if (!mentionsFrontend && !mentionsBackend) return { frontend: true, backend: true };
  return { frontend: mentionsFrontend, backend: mentionsBackend };
}

function formatOpenQuestions(questions: string[]): string {
  return questions.length
    ? questions.map((q, i) => `${i + 1}. ${q}`).join('\n')
    : '(reviewer marked BLOCKED without listing specific open questions)';
}

/**
 * A prior top-level `npm run dev-team` invocation may have already left a findings doc on
 * this ticket's branch (this is exactly what happened running P9-003 across several separate
 * process runs) — read it once so the first prompt of *this* run can hand it straight to the
 * implementer instead of leaving it to rediscover "what's blocking this" via a broad sweep.
 */
function readPriorFindings(worktreePath: string, ticketId: string): string | null {
  const findingsPath = path.join(worktreePath, 'docs', `${ticketId}-findings.md`);
  try {
    const content = fs.readFileSync(findingsPath, 'utf8');
    return content.length > MAX_PRIOR_FINDINGS_CHARS
      ? `${content.slice(0, MAX_PRIOR_FINDINGS_CHARS)}\n…(truncated)`
      : content;
  } catch {
    return null;
  }
}

export async function runCoordinator(ticketId: string): Promise<CoordinatorResult> {
  const config = loadConfig();
  const ticket = findTicket(config.repoRoot, ticketId);
  const worktree = ensureWorktree(config.repoRoot, ticketId, config.baseBranch);
  const environmentFacts = formatEnvironmentFacts(probeEnvironment());

  const pillars = detectPillars(ticket);
  const ticketPrompt = `Ticket: ${ticket.heading}\n\n${ticket.body}`;
  const priorFindings = readPriorFindings(worktree.path, ticketId);

  let fixCycles = 0;
  let lastOpenQuestions = '';

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const implementerHandoffs: ImplementerHandoff[] = [];
    const implementerRuns: Promise<void>[] = [];
    const prompt =
      fixCycles === 0
        ? priorFindings
          ? `${ticketPrompt}\n\nThis worktree already has a findings doc from an earlier run — ` +
            `read it before doing any broad exploration, it likely already answers "what's ` +
            `blocking this":\n\n${priorFindings}`
          : ticketPrompt
        : `${ticketPrompt}\n\nReviewer found this BLOCKED last pass — address these open questions:\n${lastOpenQuestions}`;

    if (pillars.frontend) {
      const frontend = createFrontendAgent({
        model: config.frontendModel,
        worktreePath: worktree.path,
        environmentFacts,
      });
      implementerRuns.push(
        frontend
          .stream(prompt, { maxSteps: MAX_STEPS, structuredOutput: { schema: implementerHandoffSchema } })
          .then(async (out) => {
            await logAgentProgress('frontend', out);
            implementerHandoffs.push(await out.object);
          }),
      );
    }
    if (pillars.backend) {
      const backend = createBackendAgent({
        model: config.backendModel,
        worktreePath: worktree.path,
        environmentFacts,
      });
      implementerRuns.push(
        backend
          .stream(prompt, { maxSteps: MAX_STEPS, structuredOutput: { schema: implementerHandoffSchema } })
          .then(async (out) => {
            await logAgentProgress('backend', out);
            implementerHandoffs.push(await out.object);
          }),
      );
    }

    await Promise.all(implementerRuns);

    // Objective cross-check against the model's own self-reported filesChanged — see
    // findOutOfPillarFiles's doc comment for why this doesn't just trust the handoff.
    const actualChangedFiles = getChangedFiles(worktree.path, config.baseBranch);
    const outOfPillar = findOutOfPillarFiles(actualChangedFiles, pillars);
    const scopeWarning = outOfPillar.length
      ? `\n\nCOORDINATOR SCOPE CHECK: these changed files fall outside every pillar invoked for ` +
        `this ticket (${JSON.stringify(pillars)}) — confirm they're actually in scope before ` +
        `passing this review: ${outOfPillar.join(', ')}`
      : '';

    const reviewer = createReviewerAgent({
      model: config.reviewerModel,
      worktreePath: worktree.path,
      baseBranch: config.baseBranch,
      environmentFacts,
    });
    const reviewOutput = await reviewer.stream(
      `Review ticket ${ticket.id} in worktree ${worktree.path} on branch ${worktree.branch} ` +
        `(base branch: ${config.baseBranch}).\n\n${ticketPrompt}${scopeWarning}`,
      { maxSteps: MAX_STEPS, structuredOutput: { schema: reviewerHandoffSchema } },
    );
    await logAgentProgress('reviewer', reviewOutput);
    const review: ReviewerHandoff = await reviewOutput.object;

    if (review.status === 'PASS') {
      return {
        ok: true,
        summary:
          `Ticket ${ticket.id}: reviewer passed.\nFindings: ${review.findingsDocPath}` +
          (review.prUrl ? `\nPR: ${review.prUrl}` : ''),
      };
    }

    lastOpenQuestions = formatOpenQuestions(review.openQuestions);
    fixCycles += 1;
    if (fixCycles > MAX_FIX_CYCLES) {
      return {
        ok: false,
        summary:
          `Ticket ${ticket.id}: still BLOCKED after ${MAX_FIX_CYCLES} fix cycles. Branch ` +
          `${worktree.branch} and its findings doc (${review.findingsDocPath}) are left in ` +
          `place for manual pickup.\n\nOpen questions:\n${lastOpenQuestions}`,
      };
    }
  }
}
