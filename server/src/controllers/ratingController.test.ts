import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const mockProductFindFirst = vi.hoisted(() => vi.fn());
const mockRatingUpsert = vi.hoisted(() => vi.fn());
const mockRatingFindMany = vi.hoisted(() => vi.fn());
const mockRatingFindUnique = vi.hoisted(() => vi.fn());

vi.mock('../db.js', () => ({
  default: {
    product: { findFirst: mockProductFindFirst },
    rating: {
      upsert: mockRatingUpsert,
      findMany: mockRatingFindMany,
      findUnique: mockRatingFindUnique,
    },
  },
}));

vi.mock('../middlewares/authMiddleware.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'user-1', email: 'test@test.com', isAnonymous: false };
    next();
  },
  requireRegistered: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../middlewares/rateLimit.js', () => ({
  apiLimiter: (_req: any, _res: any, next: any) => next(),
  userLimiter: (_req: any, _res: any, next: any) => next(),
  syncLimiter: (_req: any, _res: any, next: any) => next(),
}));

import app from '../app.js';
import { ProductKind, ProductStatus } from '../generated/prisma_client/enums.js';

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';
const PRODUCT = { id: PRODUCT_ID, kind: ProductKind.PACKAGED, name: 'Rye Bread', brand: null, image: null };

describe('POST /api/ratings', () => {
  beforeEach(() => {
    mockProductFindFirst.mockReset();
    mockRatingUpsert.mockReset();
    mockRatingFindUnique.mockReset();
  });

  it('returns 400 when productId is missing', async () => {
    const res = await request(app)
      .post('/api/ratings')
      .set('Authorization', 'Bearer token')
      .send({ taste: 7.5 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when productId is not a valid UUID', async () => {
    const res = await request(app)
      .post('/api/ratings')
      .set('Authorization', 'Bearer token')
      .send({ productId: '1234567890123', taste: 7.5 });
    expect(res.status).toBe(400);
    expect(mockProductFindFirst).not.toHaveBeenCalled();
  });

  it('returns 400 when taste is missing', async () => {
    const res = await request(app)
      .post('/api/ratings')
      .set('Authorization', 'Bearer token')
      .send({ productId: PRODUCT_ID });
    expect(res.status).toBe(400);
  });

  it('returns 400 when taste is out of range (above 10)', async () => {
    const res = await request(app)
      .post('/api/ratings')
      .set('Authorization', 'Bearer token')
      .send({ productId: PRODUCT_ID, taste: 10.5 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when taste is out of range (below 0)', async () => {
    const res = await request(app)
      .post('/api/ratings')
      .set('Authorization', 'Bearer token')
      .send({ productId: PRODUCT_ID, taste: -0.5 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when taste is not on a 0.5 boundary', async () => {
    const res = await request(app)
      .post('/api/ratings')
      .set('Authorization', 'Bearer token')
      .send({ productId: PRODUCT_ID, taste: 7.3 });
    expect(res.status).toBe(400);
  });

  it('returns 404 when the product does not exist in the DB', async () => {
    mockProductFindFirst.mockResolvedValue(null);
    const res = await request(app)
      .post('/api/ratings')
      .set('Authorization', 'Bearer token')
      .send({ productId: PRODUCT_ID, taste: 7.5 });
    expect(res.status).toBe(404);
  });

  it('returns 404 for a REJECTED product (visibility rule filters it out of the query)', async () => {
    // visibleProductWhere is baked into the findFirst `where`, so a REJECTED
    // row is indistinguishable here from a missing one.
    mockProductFindFirst.mockResolvedValue(null);
    const res = await request(app)
      .post('/api/ratings')
      .set('Authorization', 'Bearer token')
      .send({ productId: PRODUCT_ID, taste: 7.5 });
    expect(res.status).toBe(404);
    expect(mockProductFindFirst).toHaveBeenCalledWith({
      where: { id: PRODUCT_ID, status: { not: ProductStatus.REJECTED } },
    });
  });

  it('creates a new rating and returns 201 when none existed yet', async () => {
    const rating = { id: 1, userId: 'user-1', productId: PRODUCT_ID, taste: 7.5, score: 7.5, comment: null, product: PRODUCT };
    mockProductFindFirst.mockResolvedValue(PRODUCT);
    mockRatingFindUnique.mockResolvedValue(null);
    mockRatingUpsert.mockResolvedValue(rating);

    const res = await request(app)
      .post('/api/ratings')
      .set('Authorization', 'Bearer token')
      .send({ productId: PRODUCT_ID, taste: 7.5 });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(1);
    expect(mockRatingUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_productId: { userId: 'user-1', productId: PRODUCT_ID } },
      }),
    );
  });

  it('updates the existing rating in place and returns 200 on re-rating', async () => {
    const updated = { id: 1, userId: 'user-1', productId: PRODUCT_ID, taste: 9, score: 9, comment: 'Better than I thought', product: PRODUCT };
    mockProductFindFirst.mockResolvedValue(PRODUCT);
    mockRatingFindUnique.mockResolvedValue({ id: 1 });
    mockRatingUpsert.mockResolvedValue(updated);

    const res = await request(app)
      .post('/api/ratings')
      .set('Authorization', 'Bearer token')
      .send({ productId: PRODUCT_ID, taste: 9, comment: 'Better than I thought' });

    expect(res.status).toBe(200);
    expect(res.body.taste).toBe(9);
    // Same row updated — no second insert
    expect(mockRatingUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ taste: 9, score: 9, comment: 'Better than I thought' }),
      }),
    );
  });

  it('stores score equal to taste', async () => {
    mockProductFindFirst.mockResolvedValue(PRODUCT);
    mockRatingFindUnique.mockResolvedValue(null);
    mockRatingUpsert.mockResolvedValue({ id: 2, score: 8.5, product: PRODUCT });

    await request(app)
      .post('/api/ratings')
      .set('Authorization', 'Bearer token')
      .send({ productId: PRODUCT_ID, taste: 8.5 });

    expect(mockRatingUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ taste: 8.5, score: 8.5 }),
        update: expect.objectContaining({ taste: 8.5, score: 8.5 }),
      })
    );
  });

  it('accepts taste at the boundaries (0 and 10)', async () => {
    mockProductFindFirst.mockResolvedValue(PRODUCT);
    mockRatingFindUnique.mockResolvedValue(null);
    mockRatingUpsert.mockResolvedValue({ id: 3, taste: 0, score: 0, product: PRODUCT });

    const resMin = await request(app)
      .post('/api/ratings')
      .set('Authorization', 'Bearer token')
      .send({ productId: PRODUCT_ID, taste: 0 });
    expect(resMin.status).toBe(201);

    mockRatingUpsert.mockResolvedValue({ id: 4, taste: 10, score: 10, product: PRODUCT });
    const resMax = await request(app)
      .post('/api/ratings')
      .set('Authorization', 'Bearer token')
      .send({ productId: PRODUCT_ID, taste: 10 });
    expect(resMax.status).toBe(201);
  });

  it('includes an optional comment when provided', async () => {
    mockProductFindFirst.mockResolvedValue(PRODUCT);
    mockRatingFindUnique.mockResolvedValue(null);
    mockRatingUpsert.mockResolvedValue({ id: 5, comment: 'Tasty!', product: PRODUCT });

    await request(app)
      .post('/api/ratings')
      .set('Authorization', 'Bearer token')
      .send({ productId: PRODUCT_ID, taste: 9, comment: 'Tasty!' });

    expect(mockRatingUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ comment: 'Tasty!' }),
        update: expect.objectContaining({ comment: 'Tasty!' }),
      })
    );
  });
});

describe('GET /api/ratings/product/:productId', () => {
  beforeEach(() => {
    mockProductFindFirst.mockReset();
    mockRatingFindMany.mockReset();
  });

  it('returns 400 for a non-UUID productId', async () => {
    const res = await request(app)
      .get('/api/ratings/product/1234567890123')
      .set('Authorization', 'Bearer token');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_product_id');
  });

  it('returns 404 when the product does not exist', async () => {
    mockProductFindFirst.mockResolvedValue(null);
    const res = await request(app)
      .get(`/api/ratings/product/${PRODUCT_ID}`)
      .set('Authorization', 'Bearer token');
    expect(res.status).toBe(404);
  });

  it('returns the list of ratings for a known product', async () => {
    const ratings = [{ id: 1, taste: 8.5, score: 8.5, user: { id: 'user-1', username: 'Jano', avatar: null } }];
    mockProductFindFirst.mockResolvedValue(PRODUCT);
    mockRatingFindMany.mockResolvedValue(ratings);

    const res = await request(app)
      .get(`/api/ratings/product/${PRODUCT_ID}`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(ratings);
  });
});

// GET /api/ratings/me/:barcode was deleted (TICKET-P6-009) — unused by the app
// since Phase 8.
