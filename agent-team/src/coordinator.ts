import { loadConfig } from './config.js';
import { findTicket, type Ticket } from './lib/tickets.js';
import { ensureWorktree } from './lib/worktree.js';
import { createFrontendAgent } from './agents/frontend-agent.js';
import { createBackendAgent } from './agents/backend-agent.js';
import { createReviewerAgent } from './agents/reviewer-agent.js';

const MAX_FIX_CYCLES = 2;
const MAX_STEPS = 60;

export interface CoordinatorResult {
  ok: boolean;
  summary: string;
}

interface Pillars {
  frontend: boolean;
  backend: boolean;
}

/**
 * Best-effort heuristic, same as the Claude Code coordinator skill: when genuinely
 * unsure, run both implementers rather than guess wrong and silently skip a pillar.
 */
function detectPillars(ticket: Ticket): Pillars {
  const text = `${ticket.heading}\n${ticket.body}`.toLowerCase();
  const mentionsFrontend = /bread-sheet-app|frontend|screen|ui\b|expo/.test(text);
  const mentionsBackend = /server\/|backend|endpoint|api\b|prisma|controller|service/.test(text);
  if (!mentionsFrontend && !mentionsBackend) return { frontend: true, backend: true };
  return { frontend: mentionsFrontend, backend: mentionsBackend };
}

function isBlocked(reviewerText: string): boolean {
  return /\bBLOCKED\b/.test(reviewerText) && !/pull\/\d+|github\.com\/.+\/pull/.test(reviewerText);
}

export async function runCoordinator(ticketId: string): Promise<CoordinatorResult> {
  const config = loadConfig();
  const ticket = findTicket(config.repoRoot, ticketId);
  const worktree = ensureWorktree(config.repoRoot, ticketId);

  const pillars = detectPillars(ticket);
  const ticketPrompt = `Ticket: ${ticket.heading}\n\n${ticket.body}`;

  let fixCycles = 0;
  let lastReviewerText = '';

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const implementerRuns: Promise<void>[] = [];

    if (pillars.frontend) {
      const frontend = createFrontendAgent({ model: config.frontendModel, worktreePath: worktree.path });
      implementerRuns.push(
        frontend
          .generate(fixCycles === 0 ? ticketPrompt : `${ticketPrompt}\n\nReviewer findings from the last pass — address these:\n${lastReviewerText}`, {
            maxSteps: MAX_STEPS,
          })
          .then(() => undefined),
      );
    }
    if (pillars.backend) {
      const backend = createBackendAgent({ model: config.backendModel, worktreePath: worktree.path });
      implementerRuns.push(
        backend
          .generate(fixCycles === 0 ? ticketPrompt : `${ticketPrompt}\n\nReviewer findings from the last pass — address these:\n${lastReviewerText}`, {
            maxSteps: MAX_STEPS,
          })
          .then(() => undefined),
      );
    }

    await Promise.all(implementerRuns);

    const reviewer = createReviewerAgent({ model: config.reviewerModel, worktreePath: worktree.path });
    const reviewOutput = await reviewer.generate(
      `Review ticket ${ticket.id} in worktree ${worktree.path} on branch ${worktree.branch}.\n\n${ticketPrompt}`,
      { maxSteps: MAX_STEPS },
    );
    lastReviewerText = reviewOutput.text ?? '';

    if (!isBlocked(lastReviewerText)) {
      return {
        ok: true,
        summary: `Ticket ${ticket.id}: reviewer passed.\n\n${lastReviewerText}`,
      };
    }

    fixCycles += 1;
    if (fixCycles > MAX_FIX_CYCLES) {
      return {
        ok: false,
        summary:
          `Ticket ${ticket.id}: still BLOCKED after ${MAX_FIX_CYCLES} fix cycles. ` +
          `Branch ${worktree.branch} and its findings doc are left in place for manual pickup.\n\n${lastReviewerText}`,
      };
    }
  }
}
