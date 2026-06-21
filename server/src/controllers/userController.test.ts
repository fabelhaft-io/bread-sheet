import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const mockUserUpsert = vi.hoisted(() => vi.fn());
const mockRatingFindMany = vi.hoisted(() => vi.fn());
const authUser = vi.hoisted(() => ({ current: { id: 'user-1', email: 'test@test.com' } as { id: string; email?: string } }));

vi.mock('../db.js', () => ({
  default: {
    user: { upsert: mockUserUpsert },
    rating: { findMany: mockRatingFindMany },
  },
}));

vi.mock('../middlewares/authMiddleware.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { ...authUser.current };
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

describe('POST /api/users/sync', () => {
  beforeEach(() => {
    mockUserUpsert.mockReset();
    authUser.current = { id: 'user-1', email: 'test@test.com' };
  });

  it('upserts the user and returns 200 with the user record', async () => {
    const user = { id: 'user-1', email: 'test@test.com', username: null, avatar: null };
    mockUserUpsert.mockResolvedValue(user);

    const res = await request(app)
      .post('/api/users/sync')
      .set('Authorization', 'Bearer token')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual(user);
    expect(mockUserUpsert).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      update: { email: 'test@test.com' },
      create: { id: 'user-1', email: 'test@test.com' },
    });
  });

  it('normalises the empty-string email of anonymous users to null', async () => {
    // Supabase anonymous sessions carry email: '' — writing that as-is would
    // collide on the unique email constraint for a second anonymous user.
    authUser.current = { id: 'anon-1', email: '' };
    const user = { id: 'anon-1', email: null, username: null, avatar: null };
    mockUserUpsert.mockResolvedValue(user);

    const res = await request(app)
      .post('/api/users/sync')
      .set('Authorization', 'Bearer token')
      .send({});

    expect(res.status).toBe(200);
    expect(mockUserUpsert).toHaveBeenCalledWith({
      where: { id: 'anon-1' },
      update: { email: null },
      create: { id: 'anon-1', email: null },
    });
  });
});

describe('GET /api/users/me/ratings', () => {
  beforeEach(() => {
    mockRatingFindMany.mockReset();
    authUser.current = { id: 'user-1', email: 'test@test.com' };
  });

  it('returns the authenticated user\'s ratings ordered by newest first', async () => {
    const ratings = [
      { id: 2, taste: 9, product: { name: 'Baguette', image: null }, createdAt: '2026-04-05' },
      { id: 1, taste: 7, product: { name: 'Rye Bread', image: null }, createdAt: '2026-04-01' },
    ];
    mockRatingFindMany.mockResolvedValue(ratings);

    const res = await request(app)
      .get('/api/users/me/ratings')
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(ratings);

    // Stored S3 keys on the included product resolve to public URLs
    mockRatingFindMany.mockResolvedValue([
      { id: 3, taste: 8, product: { name: 'Ciabatta', image: 'processed/abc.jpg' }, createdAt: '2026-04-06' },
    ]);
    const res2 = await request(app)
      .get('/api/users/me/ratings')
      .set('Authorization', 'Bearer token');
    expect(res2.body[0].product.image).toBe('http://assets.test/test-bucket/processed/abc.jpg');
    expect(mockRatingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1' },
        orderBy: { createdAt: 'desc' },
      })
    );
  });
});
