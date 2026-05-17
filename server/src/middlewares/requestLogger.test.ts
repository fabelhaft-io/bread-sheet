import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { requestLogger } from './requestLogger.js';
import logger from '../logger.js';

type Listener = () => void;

function makeReqRes(opts: {
  status: number;
  method?: string;
  url?: string;
  ip?: string;
  user?: { id: string; isAnonymous: boolean };
  requestId?: string;
}) {
  const listeners: Record<string, Listener[]> = {};
  const req: any = {
    method: opts.method ?? 'GET',
    originalUrl: opts.url ?? '/api/test',
    ip: opts.ip ?? '127.0.0.1',
    headers: opts.requestId ? { 'x-request-id': opts.requestId } : {},
    user: opts.user,
  };
  const res: any = {
    statusCode: opts.status,
    on(event: string, fn: Listener) {
      (listeners[event] ??= []).push(fn);
    },
    _emit(event: string) {
      (listeners[event] ?? []).forEach((fn) => fn());
    },
  };
  return { req, res };
}

describe('requestLogger', () => {
  beforeEach(() => {
    (logger.debug as any).mockReset();
    (logger.info as any).mockReset();
    (logger.warn as any).mockReset();
    (logger.error as any).mockReset();
  });

  it('logs request:start at debug level when the request begins', () => {
    const { req, res } = makeReqRes({ status: 200 });
    const next = vi.fn();
    requestLogger(req, res, next);
    expect(logger.debug).toHaveBeenCalledWith(
      'request:start',
      expect.objectContaining({ method: 'GET', path: '/api/test', ip: '127.0.0.1' }),
    );
    expect(next).toHaveBeenCalled();
  });

  it('emits an info log for a 2xx response with the resolved userId', () => {
    const { req, res } = makeReqRes({
      status: 201,
      method: 'POST',
      url: '/api/ratings',
      user: { id: 'u-1', isAnonymous: true },
    });
    requestLogger(req, res, vi.fn());
    res._emit('finish');
    expect(logger.info).toHaveBeenCalledWith(
      'request:finish',
      expect.objectContaining({
        method: 'POST',
        path: '/api/ratings',
        status: 201,
        userId: 'u-1',
        isAnonymous: true,
      }),
    );
  });

  it('emits a warn log for 4xx responses (so they stand out from regular traffic)', () => {
    const { req, res } = makeReqRes({ status: 404, url: '/api/products/0' });
    requestLogger(req, res, vi.fn());
    res._emit('finish');
    expect(logger.warn).toHaveBeenCalledWith(
      'request:finish',
      expect.objectContaining({ status: 404 }),
    );
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('emits an error log for 5xx responses', () => {
    const { req, res } = makeReqRes({ status: 500 });
    requestLogger(req, res, vi.fn());
    res._emit('finish');
    expect(logger.error).toHaveBeenCalledWith(
      'request:finish',
      expect.objectContaining({ status: 500 }),
    );
  });

  it('passes the x-request-id header through into the log payload', () => {
    const { req, res } = makeReqRes({ status: 200, requestId: 'abc-123' });
    requestLogger(req, res, vi.fn());
    res._emit('finish');
    expect(logger.info).toHaveBeenCalledWith(
      'request:finish',
      expect.objectContaining({ requestId: 'abc-123' }),
    );
  });
});
