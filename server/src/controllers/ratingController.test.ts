import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const mockProductFindUnique = vi.hoisted(() => vi.fn());
const mockRatingUpsert = vi.hoisted(() => vi.fn());
const mockRatingFindMany = vi.hoisted(() => vi.fn());
const mockRatingFindUnique = vi.hoisted(() => vi.fn());

vi.mock('../db.js', () => ({
  default: {
    product: { findUnique: mockProductFindUnique },
    rating: {
      upsert: mockRatingUpsert,
      findMany: mockRatingFindMany,
      findUnique: mockRatingFindUnique,
    },
  },
}));

vi.mock('../middlewares/authMiddleware.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'user-1', email: 'test@test.com' };
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

const PRODUCT = { id: 10, barcode: '1234567890123', name: 'Rye Bread' };

describe('POST /api/ratings', () => {
  beforeEach(() => {
    mockProductFindUnique.mockReset();
    mockRatingUpsert.mockReset();
    mockRatingFindUnique.mockReset();
  });

  it('returns 400 when barcode is missing', async () => {
    const res = await request(app)
      .post('/api/ratings')
      .set('Authorization', 'Bearer token')
      .send({ taste: 7.5 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when taste is missing', async () => {
    const res = await request(app)
      .post('/api/ratings')
      .set('Authorization', 'Bearer token')
      .send({ barcode: '1234567890123' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when taste is out of range (above 10)', async () => {
    const res = await request(app)
      .post('/api/ratings')
      .set('Authorization', 'Bearer token')
      .send({ barcode: '1234567890123', taste: 10.5 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when taste is out of range (below 0)', async () => {
    const res = await request(app)
      .post('/api/ratings')
      .set('Authorization', 'Bearer token')
      .send({ barcode: '1234567890123', taste: -0.5 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when taste is not on a 0.5 boundary', async () => {
    const res = await request(app)
      .post('/api/ratings')
      .set('Authorization', 'Bearer token')
      .send({ barcode: '1234567890123', taste: 7.3 });
    expect(res.status).toBe(400);
  });

  it('returns 404 when the product does not exist in the DB', async () => {
    mockProductFindUnique.mockResolvedValue(null);
    const res = await request(app)
      .post('/api/ratings')
      .set('Authorization', 'Bearer token')
      .send({ barcode: '1234567890123', taste: 7.5 });
    expect(res.status).toBe(404);
  });

  it('creates a new rating and returns 201 when none existed yet', async () => {
    const rating = { id: 1, userId: 'user-1', productId: 10, taste: 7.5, score: 7.5, comment: null, product: PRODUCT };
    mockProductFindUnique.mockResolvedValue(PRODUCT);
    mockRatingFindUnique.mockResolvedValue(null);
    mockRatingUpsert.mockResolvedValue(rating);

    const res = await request(app)
      .post('/api/ratings')
      .set('Authorization', 'Bearer token')
      .send({ barcode: '1234567890123', taste: 7.5 });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(1);
    expect(mockRatingUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_productId: { userId: 'user-1', productId: 10 } },
      }),
    );
  });

  it('updates the existing rating in place and returns 200 on re-rating', async () => {
    const updated = { id: 1, userId: 'user-1', productId: 10, taste: 9, score: 9, comment: 'Better than I thought', product: PRODUCT };
    mockProductFindUnique.mockResolvedValue(PRODUCT);
    mockRatingFindUnique.mockResolvedValue({ id: 1 });
    mockRatingUpsert.mockResolvedValue(updated);

    const res = await request(app)
      .post('/api/ratings')
      .set('Authorization', 'Bearer token')
      .send({ barcode: '1234567890123', taste: 9, comment: 'Better than I thought' });

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
    mockProductFindUnique.mockResolvedValue(PRODUCT);
    mockRatingFindUnique.mockResolvedValue(null);
    mockRatingUpsert.mockResolvedValue({ id: 2, score: 8.5, product: PRODUCT });

    await request(app)
      .post('/api/ratings')
      .set('Authorization', 'Bearer token')
      .send({ barcode: '1234567890123', taste: 8.5 });

    expect(mockRatingUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ taste: 8.5, score: 8.5 }),
        update: expect.objectContaining({ taste: 8.5, score: 8.5 }),
      })
    );
  });

  it('accepts taste at the boundaries (0 and 10)', async () => {
    mockProductFindUnique.mockResolvedValue(PRODUCT);
    mockRatingFindUnique.mockResolvedValue(null);
    mockRatingUpsert.mockResolvedValue({ id: 3, taste: 0, score: 0, product: PRODUCT });

    const resMin = await request(app)
      .post('/api/ratings')
      .set('Authorization', 'Bearer token')
      .send({ barcode: '1234567890123', taste: 0 });
    expect(resMin.status).toBe(201);

    mockRatingUpsert.mockResolvedValue({ id: 4, taste: 10, score: 10, product: PRODUCT });
    const resMax = await request(app)
      .post('/api/ratings')
      .set('Authorization', 'Bearer token')
      .send({ barcode: '1234567890123', taste: 10 });
    expect(resMax.status).toBe(201);
  });

  it('includes an optional comment when provided', async () => {
    mockProductFindUnique.mockResolvedValue(PRODUCT);
    mockRatingFindUnique.mockResolvedValue(null);
    mockRatingUpsert.mockResolvedValue({ id: 5, comment: 'Tasty!', product: PRODUCT });

    await request(app)
      .post('/api/ratings')
      .set('Authorization', 'Bearer token')
      .send({ barcode: '1234567890123', taste: 9, comment: 'Tasty!' });

    expect(mockRatingUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ comment: 'Tasty!' }),
        update: expect.objectContaining({ comment: 'Tasty!' }),
      })
    );
  });
});

describe('GET /api/ratings/product/:barcode', () => {
  beforeEach(() => {
    mockProductFindUnique.mockReset();
    mockRatingFindMany.mockReset();
  });

  it('returns 404 when the product does not exist', async () => {
    mockProductFindUnique.mockResolvedValue(null);
    const res = await request(app)
      .get('/api/ratings/product/1234567890123')
      .set('Authorization', 'Bearer token');
    expect(res.status).toBe(404);
  });

  it('returns the list of ratings for a known product', async () => {
    const ratings = [{ id: 1, taste: 8.5, score: 8.5, user: { id: 'user-1', username: 'Jano', avatar: null } }];
    mockProductFindUnique.mockResolvedValue(PRODUCT);
    mockRatingFindMany.mockResolvedValue(ratings);

    const res = await request(app)
      .get('/api/ratings/product/1234567890123')
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(ratings);
  });
});

describe('GET /api/ratings/me/:barcode', () => {
  beforeEach(() => {
    mockProductFindUnique.mockReset();
    mockRatingFindUnique.mockReset();
  });

  it('returns 404 when the product does not exist', async () => {
    mockProductFindUnique.mockResolvedValue(null);
    const res = await request(app)
      .get('/api/ratings/me/1234567890123')
      .set('Authorization', 'Bearer token');
    expect(res.status).toBe(404);
  });

  it('returns 404 when the caller has not rated this product', async () => {
    mockProductFindUnique.mockResolvedValue(PRODUCT);
    mockRatingFindUnique.mockResolvedValue(null);
    const res = await request(app)
      .get('/api/ratings/me/1234567890123')
      .set('Authorization', 'Bearer token');
    expect(res.status).toBe(404);
  });

  it('returns the caller’s rating when one exists', async () => {
    const rating = { id: 'r1', userId: 'user-1', productId: 10, taste: 6, score: 6, comment: null };
    mockProductFindUnique.mockResolvedValue(PRODUCT);
    mockRatingFindUnique.mockResolvedValue(rating);

    const res = await request(app)
      .get('/api/ratings/me/1234567890123')
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(rating);
    expect(mockRatingFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_productId: { userId: 'user-1', productId: 10 } },
      }),
    );
  });
});
