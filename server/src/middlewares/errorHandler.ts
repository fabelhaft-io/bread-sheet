import { Request, Response, NextFunction } from 'express';
import logger from '../logger.js';
import type { AuthRequest } from './authMiddleware.js';

/**
 * Application-level error.
 *
 * `status`  — HTTP status code to send to the client.
 * `expose`  — if true, the original `err.message` is safe to send to the
 *             client. If false / unset, the client only ever sees a generic
 *             message for the status class (no Prisma text, no stack, no
 *             raw DB column names, etc.). Defaults to `true` for 4xx and
 *             `false` for 5xx — matching the convention used by `http-errors`.
 * `code`    — optional short machine-readable code (e.g. `"invalid_barcode"`).
 *             Sent to the client; safe to display in UI keyed off the value.
 */
export interface AppError extends Error {
  status?: number;
  expose?: boolean;
  code?: string;
}

const GENERIC_CLIENT_MESSAGES: Record<number, string> = {
  400: 'The request was invalid.',
  401: 'You need to be signed in to do that.',
  403: 'You do not have permission to do that.',
  404: 'Not found.',
  409: 'That conflicts with the current state of the resource.',
  415: 'That file type is not supported.',
  422: 'The request could not be processed.',
  429: 'Too many requests. Please try again in a moment.',
};

const DEFAULT_5XX_MESSAGE = 'Something went wrong on our end. Please try again.';

// Prisma client errors carry a `code` string property (e.g. "P2003") and a
// fairly verbose `message` that includes SQL fragments, column names, and
// constraint identifiers. We never want that text to leave the server.
type PrismaLikeError = Error & { code?: string; meta?: Record<string, unknown>; clientVersion?: string };

function isPrismaError(err: unknown): err is PrismaLikeError {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: string }).name;
  return (
    typeof name === 'string' &&
    (name === 'PrismaClientKnownRequestError' ||
      name === 'PrismaClientUnknownRequestError' ||
      name === 'PrismaClientValidationError' ||
      name === 'PrismaClientInitializationError' ||
      name === 'PrismaClientRustPanicError')
  );
}

/**
 * Map a Prisma error to (status, generic message). The generic message is
 * what the client sees; the full Prisma details are only logged server-side.
 *
 * We deliberately do NOT include column / constraint names in client output —
 * that is information disclosure to a potential attacker (it reveals the
 * schema shape). The codes we map are:
 *
 *   - P2002 — unique constraint violation       → 409 "Already exists."
 *   - P2003 — foreign-key constraint violation  → 409 "Referenced item does not exist."
 *   - P2025 — record required for op not found  → 404 "Not found."
 *
 * Any other Prisma error collapses to a generic 500. Adding more mappings
 * over time is safe — just add a case here.
 */
function mapPrismaError(err: PrismaLikeError): { status: number; message: string; code?: string } {
  switch (err.code) {
    case 'P2002':
      return { status: 409, message: 'That item already exists.', code: 'unique_violation' };
    case 'P2003':
      return {
        status: 409,
        message: 'A referenced item does not exist yet. Please refresh and try again.',
        code: 'foreign_key_violation',
      };
    case 'P2025':
      return { status: 404, message: 'Not found.', code: 'not_found' };
    default:
      return { status: 500, message: DEFAULT_5XX_MESSAGE };
  }
}

/**
 * Global error handler.
 *
 * Two-channel design:
 *
 *   1. Server log — full details (stack, Prisma code, meta, original
 *      message, path, method, userId). This is what the operator sees.
 *
 *   2. Client response — a sanitized JSON body. The original error
 *      message is ONLY forwarded when `err.expose === true` (which we
 *      set on validation / 4xx errors that intentionally carry safe
 *      copy). 5xx errors and Prisma errors collapse to generic copy so
 *      we never leak schema details or stack traces.
 *
 * The shape is `{ message, code? }` — `code` is included for known mapped
 * errors so the client can branch on it without parsing strings.
 */
export const errorHandler = (
  err: AppError | PrismaLikeError,
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  const user = (req as AuthRequest).user;

  // 1. Resolve status + client-safe message.
  let status: number;
  let message: string;
  let code: string | undefined;

  if (isPrismaError(err)) {
    const mapped = mapPrismaError(err);
    status = mapped.status;
    message = mapped.message;
    code = mapped.code;
  } else {
    const appErr = err as AppError;
    status = appErr.status ?? 500;
    code = appErr.code;

    if (status >= 500) {
      message = DEFAULT_5XX_MESSAGE;
    } else if (appErr.expose === false) {
      message = GENERIC_CLIENT_MESSAGES[status] ?? GENERIC_CLIENT_MESSAGES[400]!;
    } else {
      // 4xx with no explicit opt-out: forward the message. Callers raising
      // 4xx errors are expected to write safe, user-facing copy.
      message = appErr.message?.trim() || GENERIC_CLIENT_MESSAGES[status] || DEFAULT_5XX_MESSAGE;
    }
  }

  // 2. Server-side log (full detail).
  const logPayload = {
    method: req.method,
    path: req.originalUrl,
    status,
    userId: user?.id,
    isAnonymous: user?.isAnonymous,
    errorName: (err as Error).name,
    errorMessage: (err as Error).message,
    prismaCode: isPrismaError(err) ? err.code : undefined,
    prismaMeta: isPrismaError(err) ? err.meta : undefined,
    stack: (err as Error).stack,
  };

  if (status >= 500) {
    logger.error('unhandled error in request', logPayload);
  } else {
    logger.warn('handled error in request', logPayload);
  }

  // 3. Sanitized client response.
  const body: { message: string; code?: string } = { message };
  if (code) body.code = code;
  res.status(status).json(body);
};
