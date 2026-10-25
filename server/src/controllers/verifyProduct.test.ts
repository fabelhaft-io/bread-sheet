import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const mockCastVote = vi.hoisted(() => vi.fn());
const session = vi.hoisted(() => ({
  user: { id: 'reviewer-1', email: 'reviewer@test.com', isAnonymous: false } as
    | { id: string; email: string | undefined; isAnonymous: boolean }
    | null,
}));

vi.mock('../services/productVerificationService.js', async () => {
  const actual = await vi.importActual<
    typeof import('../services/productVerificationService.js')
  >('../services/productVerificationService.js');
  return { ...actual, castVote: mockCastVote };
});

vi.mock('../middlewares/authMiddleware.js', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (!session.user) return res.status(401).json({ error: 'unauthorised' });
    req.user = session.user;
    next();
  },
  requireRegistered: (req: any, res: any, next: any) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (req.user.isAnonymous) return res.status(403).json({ error: 'Registration required' });
    next();
  },
}));

vi.mock('../middlewares/rateLimit.js', () => ({
  apiLimiter: (_req: any, _res: any, next: any) => next(),
  userLimiter: (_req: any, _res: any, next: any) => next(),
  syncLimiter: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../db.js', () => ({
  default: {
    product: { findFirst: vi.fn(), create: vi.fn() },
    packagedProduct: { findUnique: vi.fn() },
  },
}));

vi.mock('../services/productService.js', async () => {
  const actual = await vi.importActual<typeof import('../services/productService.js')>(
    '../services/productService.js',
  );
  return { ...actual, fetchFromOpenFoodFacts: vi.fn(), createSubmittedProduct: vi.fn() };
});

import app from '../app.js';
import {
  ProductNotFoundError,
  ProductNotPendingError,
  SelfVerificationError,
} from '../services/productVerificationService.js';
import { ProductStatus, VerificationVote } from '../generated/prisma_client/enums.js';

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';

function resetSession() {
  session.user = { id: 'reviewer-1', email: 'reviewer@test.com', isAnonymous: false };
}

describe('POST /api/products/:productId/verify', () => {
  beforeEach(() => {
    mockCastVote.mockReset();
    resetSession();
  });

  it('returns 200 with verifications count on APPROVE', async () => {
    mockCastVote.mockResolvedValue({ verifications: 1, status: ProductStatus.PENDING_REVIEW });

    const res = await request(app)
      .post(`/api/products/${PRODUCT_ID}/verify`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ verifications: 1 });
    expect(mockCastVote).toHaveBeenCalledWith(PRODUCT_ID, 'reviewer-1', VerificationVote.APPROVE);
  });

  it('returns 400 for a non-UUID productId', async () => {
    const res = await request(app)
      .post('/api/products/not-a-uuid/verify')
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_product_id');
    expect(mockCastVote).not.toHaveBeenCalled();
  });

  it('returns 403 when the submitter tries to self-verify', async () => {
    mockCastVote.mockRejectedValue(new SelfVerificationError());

    const res = await request(app)
      .post(`/api/products/${PRODUCT_ID}/verify`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('self_verification');
  });

  it('returns 404 when the product does not exist', async () => {
    mockCastVote.mockRejectedValue(new ProductNotFoundError(PRODUCT_ID));

    const res = await request(app)
      .post(`/api/products/${PRODUCT_ID}/verify`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('product_not_found');
  });

  it('returns 409 when the product is not in PENDING_REVIEW', async () => {
    mockCastVote.mockRejectedValue(new ProductNotPendingError(PRODUCT_ID));

    const res = await request(app)
      .post(`/api/products/${PRODUCT_ID}/verify`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('product_not_pending');
  });

  it('returns 403 when the caller is anonymous', async () => {
    session.user = { id: 'anon-1', email: undefined, isAnonymous: true };

    const res = await request(app)
      .post(`/api/products/${PRODUCT_ID}/verify`)
      .set('Authorization', 'Bearer anon-token');

    expect(res.status).toBe(403);
    expect(mockCastVote).not.toHaveBeenCalled();
  });

  it('returns 401 when unauthenticated', async () => {
    session.user = null;

    const res = await request(app).post(`/api/products/${PRODUCT_ID}/verify`);

    expect(res.status).toBe(401);
    expect(mockCastVote).not.toHaveBeenCalled();
  });

  it('forwards unexpected errors to the central error handler', async () => {
    mockCastVote.mockRejectedValue(new Error('boom'));

    const res = await request(app)
      .post(`/api/products/${PRODUCT_ID}/verify`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(500);
  });
});

describe('DELETE /api/products/:productId/verify', () => {
  beforeEach(() => {
    mockCastVote.mockReset();
    resetSession();
  });

  it('returns 200 and casts a REJECT vote (not a retraction)', async () => {
    mockCastVote.mockResolvedValue({ verifications: 1, status: ProductStatus.PENDING_REVIEW });

    const res = await request(app)
      .delete(`/api/products/${PRODUCT_ID}/verify`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ verifications: 1 });
    expect(mockCastVote).toHaveBeenCalledWith(PRODUCT_ID, 'reviewer-1', VerificationVote.REJECT);
  });

  it('returns 404 when the product does not exist', async () => {
    mockCastVote.mockRejectedValue(new ProductNotFoundError(PRODUCT_ID));

    const res = await request(app)
      .delete(`/api/products/${PRODUCT_ID}/verify`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('product_not_found');
  });

  it('returns 409 when the product is not in PENDING_REVIEW', async () => {
    mockCastVote.mockRejectedValue(new ProductNotPendingError(PRODUCT_ID));

    const res = await request(app)
      .delete(`/api/products/${PRODUCT_ID}/verify`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('product_not_pending');
  });

  it('returns 403 when the caller is anonymous', async () => {
    session.user = { id: 'anon-1', email: undefined, isAnonymous: true };

    const res = await request(app)
      .delete(`/api/products/${PRODUCT_ID}/verify`)
      .set('Authorization', 'Bearer anon-token');

    expect(res.status).toBe(403);
    expect(mockCastVote).not.toHaveBeenCalled();
  });
});
