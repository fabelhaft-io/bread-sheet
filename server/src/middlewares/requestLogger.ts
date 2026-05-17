import { Request, Response, NextFunction } from 'express';
import logger from '../logger.js';
import type { AuthRequest } from './authMiddleware.js';

/**
 * Structured per-request logger.
 *
 * Emits one log line at request start (debug) and one at response finish
 * (info / warn / error depending on status). Each line carries:
 *   - method, path, statusCode, durationMs
 *   - userId + isAnonymous (when auth middleware has already run)
 *   - remote IP
 *   - x-request-id (if present) so individual requests can be traced
 *
 * Plug this in BEFORE controllers but AFTER body parsers, so that paths and
 * IPs are populated. It is safe to mount before auth — `req.user` is read
 * lazily on the `finish` event, by which time the auth middleware (if any)
 * has populated it.
 */
export const requestLogger = (req: Request, res: Response, next: NextFunction) => {
  const start = process.hrtime.bigint();
  const requestId = (req.headers['x-request-id'] as string | undefined) ?? undefined;

  // Lightweight start log — useful when a request hangs and never reaches `finish`.
  logger.debug('request:start', {
    method: req.method,
    path: req.originalUrl,
    ip: req.ip,
    requestId,
  });

  res.on('finish', () => {
    const durationMs = Number((process.hrtime.bigint() - start) / 1_000_000n);
    const status = res.statusCode;
    const user = (req as AuthRequest).user;

    const payload = {
      method: req.method,
      path: req.originalUrl,
      status,
      durationMs,
      userId: user?.id,
      isAnonymous: user?.isAnonymous,
      ip: req.ip,
      requestId,
    };

    if (status >= 500) {
      logger.error('request:finish', payload);
    } else if (status >= 400) {
      logger.warn('request:finish', payload);
    } else {
      logger.info('request:finish', payload);
    }
  });

  next();
};
