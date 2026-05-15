import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted ensures this mock fn exists when vi.mock() factory runs (ESM hoisting)
const mockGetUser = vi.hoisted(() => vi.fn());

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getUser: mockGetUser },
  }),
}));

import { requireAuth, requireRegistered } from './authMiddleware.js';

function makeReqResNext(authHeader?: string) {
  const req: any = { headers: {} };
  if (authHeader !== undefined) req.headers.authorization = authHeader;
  const res: any = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  const next = vi.fn();
  return { req, res, next };
}

describe('requireAuth', () => {
  beforeEach(() => {
    mockGetUser.mockReset();
  });

  it('returns 401 when Authorization header is missing', async () => {
    const { req, res, next } = makeReqResNext();
    await requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Authorization header missing' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when the Bearer token is absent from the header', async () => {
    const { req, res, next } = makeReqResNext('Bearer');
    await requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Token missing' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when Supabase reports an invalid token', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: new Error('invalid jwt') });
    const { req, res, next } = makeReqResNext('Bearer bad-token');
    await requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or expired token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('attaches user with isAnonymous=false for a registered user (is_anonymous: false)', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-123', email: 'test@example.com', is_anonymous: false } },
      error: null,
    });
    const { req, res, next } = makeReqResNext('Bearer valid-token');
    await requireAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toEqual({ id: 'user-123', email: 'test@example.com', isAnonymous: false });
  });

  it('attaches user with isAnonymous=true for an anonymous user (is_anonymous: true)', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'anon-456', email: undefined, is_anonymous: true } },
      error: null,
    });
    const { req, res, next } = makeReqResNext('Bearer anon-token');
    await requireAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toEqual({ id: 'anon-456', email: undefined, isAnonymous: true });
  });

  it('treats missing is_anonymous field as anonymous (isAnonymous=true)', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-789', email: 'other@example.com' } },
      error: null,
    });
    const { req, res, next } = makeReqResNext('Bearer legacy-token');
    await requireAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toEqual({ id: 'user-789', email: 'other@example.com', isAnonymous: true });
  });

  it('returns 500 when an unexpected error is thrown', async () => {
    mockGetUser.mockRejectedValue(new Error('network failure'));
    const { req, res, next } = makeReqResNext('Bearer some-token');
    await requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error during authentication' });
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireRegistered', () => {
  it('returns 401 when req.user is not set', () => {
    const { req, res, next } = makeReqResNext();
    requireRegistered(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Authentication required' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when the user is anonymous', () => {
    const { req, res, next } = makeReqResNext();
    req.user = { id: 'anon-1', email: undefined, isAnonymous: true };
    requireRegistered(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Registration required' });
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() when the user is registered', () => {
    const { req, res, next } = makeReqResNext();
    req.user = { id: 'user-1', email: 'registered@example.com', isAnonymous: false };
    requireRegistered(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});