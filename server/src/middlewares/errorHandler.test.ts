import { describe, it, expect, vi } from 'vitest';
import { errorHandler, type AppError } from './errorHandler.js';

function makeReqResNext() {
  const req: any = { method: 'GET', originalUrl: '/api/test', headers: {} };
  const res: any = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  const next: any = vi.fn();
  return { req, res, next };
}

/**
 * Build a fake Prisma error. The real ones come from the prisma runtime —
 * we just need the shape that `isPrismaError` recognises.
 */
function makePrismaError(code: string, message = 'Raw Prisma message with `column_x` details') {
  const err = new Error(message) as Error & { code: string; meta: Record<string, unknown> };
  err.name = 'PrismaClientKnownRequestError';
  err.code = code;
  err.meta = { target: ['userId'] };
  return err;
}

describe('errorHandler', () => {
  it('uses err.status when provided and forwards the message for 4xx', () => {
    const { req, res, next } = makeReqResNext();
    const err: AppError = Object.assign(new Error('Custom 404 copy'), { status: 404 });
    errorHandler(err, req, res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'Custom 404 copy' });
  });

  it('defaults to status 500 when err.status is absent', () => {
    const { req, res, next } = makeReqResNext();
    const err: AppError = new Error('Something broke');
    errorHandler(err, req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    // 5xx must NEVER forward the raw message — always a generic copy.
    expect(res.json).toHaveBeenCalledWith({ message: expect.stringContaining('Something went wrong') });
  });

  it('forwards the explicit message when err.status is a known 4xx', () => {
    const { req, res, next } = makeReqResNext();
    const err: AppError = Object.assign(new Error('barcode is required'), { status: 400 });
    errorHandler(err, req, res, next);
    expect(res.json).toHaveBeenCalledWith({ message: 'barcode is required' });
  });

  it('substitutes generic copy for 4xx when expose:false is set', () => {
    const { req, res, next } = makeReqResNext();
    const err: AppError = Object.assign(new Error('verbose internal copy'), { status: 403, expose: false });
    errorHandler(err, req, res, next);
    expect(res.json).toHaveBeenCalledWith({
      message: expect.not.stringContaining('verbose internal copy'),
    });
    const body = (res.json as any).mock.calls[0][0];
    expect(body.message).toMatch(/permission/i);
  });

  it('includes err.code in the response body when set', () => {
    const { req, res, next } = makeReqResNext();
    const err: AppError = Object.assign(new Error('Already exists'), { status: 409, code: 'product_already_verified' });
    errorHandler(err, req, res, next);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Already exists',
      code: 'product_already_verified',
    });
  });

  it('falls back to status-derived copy when message is empty', () => {
    const { req, res, next } = makeReqResNext();
    const err: AppError = Object.assign(new Error(''), { status: 404 });
    errorHandler(err, req, res, next);
    expect(res.json).toHaveBeenCalledWith({ message: 'Not found.' });
  });

  describe('Prisma errors', () => {
    it('maps P2002 (unique violation) to a generic 409 and never leaks the raw message', () => {
      const { req, res, next } = makeReqResNext();
      const err = makePrismaError('P2002', 'Unique constraint failed on the fields: (`barcode`)');
      errorHandler(err as any, req, res, next);
      expect(res.status).toHaveBeenCalledWith(409);
      const body = (res.json as any).mock.calls[0][0];
      expect(body.message).not.toContain('Unique constraint');
      expect(body.message).not.toContain('barcode');
      expect(body.code).toBe('unique_violation');
    });

    it('maps P2003 (FK violation) to a 409 with safe copy — covers the rating-as-unsynced-user case', () => {
      const { req, res, next } = makeReqResNext();
      const err = makePrismaError(
        'P2003',
        'Foreign key constraint failed on the field: `Rating_userId_fkey (index)`',
      );
      errorHandler(err as any, req, res, next);
      expect(res.status).toHaveBeenCalledWith(409);
      const body = (res.json as any).mock.calls[0][0];
      expect(body.message).not.toMatch(/Foreign key|userId|Rating_/);
      expect(body.code).toBe('foreign_key_violation');
    });

    it('maps P2025 (record not found) to 404 with safe copy', () => {
      const { req, res, next } = makeReqResNext();
      const err = makePrismaError('P2025', 'An operation failed because it depends on one or more records that were required but not found');
      errorHandler(err as any, req, res, next);
      expect(res.status).toHaveBeenCalledWith(404);
      const body = (res.json as any).mock.calls[0][0];
      expect(body.message).toBe('Not found.');
      expect(body.code).toBe('not_found');
    });

    it('unmapped Prisma codes collapse to a generic 500', () => {
      const { req, res, next } = makeReqResNext();
      const err = makePrismaError('P9999', 'Some scary internal Prisma details');
      errorHandler(err as any, req, res, next);
      expect(res.status).toHaveBeenCalledWith(500);
      const body = (res.json as any).mock.calls[0][0];
      expect(body.message).not.toContain('scary');
    });

    it('PrismaClientValidationError collapses to a generic 500 without leaking the message', () => {
      const { req, res, next } = makeReqResNext();
      const err = new Error('Invalid `prisma.rating.create()` invocation:\n\nArgument `userId`: …');
      err.name = 'PrismaClientValidationError';
      errorHandler(err as any, req, res, next);
      expect(res.status).toHaveBeenCalledWith(500);
      const body = (res.json as any).mock.calls[0][0];
      expect(body.message).not.toContain('prisma.rating.create');
      expect(body.message).not.toContain('userId');
    });
  });
});
