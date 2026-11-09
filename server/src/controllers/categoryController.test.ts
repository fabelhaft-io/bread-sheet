import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const mockListMyCategories = vi.hoisted(() => vi.fn());
const mockCreateCategory = vi.hoisted(() => vi.fn());
const mockRenameCategory = vi.hoisted(() => vi.fn());
const mockDeleteCategory = vi.hoisted(() => vi.fn());
const mockMergeCategory = vi.hoisted(() => vi.fn());

const session = vi.hoisted(() => ({
  user: { id: 'user-1', email: 'test@test.com', isAnonymous: false } as
    | { id: string; email: string | undefined; isAnonymous: boolean }
    | null,
}));

vi.mock('../services/categoryService.js', async () => {
  const actual = await vi.importActual<typeof import('../services/categoryService.js')>(
    '../services/categoryService.js',
  );
  return {
    ...actual,
    listMyCategories: mockListMyCategories,
    createCategory: mockCreateCategory,
    renameCategory: mockRenameCategory,
    deleteCategory: mockDeleteCategory,
    mergeCategory: mockMergeCategory,
  };
});

// Pulled in transitively by app.ts's other routes; stub to keep this test DB-free.
vi.mock('../db.js', () => ({ default: {} }));

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

import app from '../app.js';
import {
  CategoryForbiddenError,
  CategoryNotFoundError,
  DuplicateCategoryNameError,
  SelfMergeError,
  TooManyCategoriesError,
} from '../services/categoryService.js';

const CATEGORY_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';

function resetSession() {
  session.user = { id: 'user-1', email: 'test@test.com', isAnonymous: false };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSession();
});

describe('GET /api/users/me/categories', () => {
  it('works for an anonymous caller (requireAuth only, not requireRegistered)', async () => {
    session.user = { id: 'anon-1', email: undefined, isAnonymous: true };
    mockListMyCategories.mockResolvedValue([]);
    const res = await request(app)
      .get('/api/users/me/categories')
      .set('Authorization', 'Bearer anon-token');
    expect(res.status).toBe(200);
    expect(mockListMyCategories).toHaveBeenCalledWith('anon-1');
  });

  it('returns 401 with no session', async () => {
    session.user = null;
    const res = await request(app).get('/api/users/me/categories');
    expect(res.status).toBe(401);
  });

  it('returns the caller\'s categories with rating counts', async () => {
    const createdAt = new Date('2026-01-01').toISOString();
    mockListMyCategories.mockResolvedValue([
      { id: 'cat-1', name: 'Wine', slug: 'wine', isSeed: true, createdAt, ratingCount: 3 },
    ]);
    const res = await request(app)
      .get('/api/users/me/categories')
      .set('Authorization', 'Bearer token');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: 'cat-1', name: 'Wine', slug: 'wine', isSeed: true, createdAt, ratingCount: 3 },
    ]);
  });
});

describe('POST /api/users/me/categories', () => {
  it('works for an anonymous caller', async () => {
    session.user = { id: 'anon-1', email: undefined, isAnonymous: true };
    mockCreateCategory.mockResolvedValue({
      id: 'cat-1',
      name: 'Wine',
      slug: 'wine',
      isSeed: true,
      createdAt: new Date(),
      ratingCount: 0,
    });
    const res = await request(app)
      .post('/api/users/me/categories')
      .set('Authorization', 'Bearer anon-token')
      .send({ seedSlug: 'wine' });
    expect(res.status).toBe(201);
    expect(mockCreateCategory).toHaveBeenCalledWith('anon-1', { seedSlug: 'wine' });
  });

  it('creates a custom category by name', async () => {
    mockCreateCategory.mockResolvedValue({
      id: 'cat-2',
      name: 'My Cocktails',
      slug: 'my-cocktails',
      isSeed: false,
      createdAt: new Date(),
      ratingCount: 0,
    });
    const res = await request(app)
      .post('/api/users/me/categories')
      .set('Authorization', 'Bearer token')
      .send({ name: 'My Cocktails' });
    expect(res.status).toBe(201);
    expect(res.body.slug).toBe('my-cocktails');
    expect(mockCreateCategory).toHaveBeenCalledWith('user-1', { name: 'My Cocktails' });
  });

  it('returns 400 when both name and seedSlug are given', async () => {
    const res = await request(app)
      .post('/api/users/me/categories')
      .set('Authorization', 'Bearer token')
      .send({ name: 'Wine', seedSlug: 'wine' });
    expect(res.status).toBe(400);
    expect(mockCreateCategory).not.toHaveBeenCalled();
  });

  it('returns 409 too_many_categories at the cap', async () => {
    mockCreateCategory.mockRejectedValue(new TooManyCategoriesError());
    const res = await request(app)
      .post('/api/users/me/categories')
      .set('Authorization', 'Bearer token')
      .send({ name: 'One More' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('too_many_categories');
  });
});

describe('PATCH /api/users/me/categories/:id', () => {
  it('returns 400 for a non-UUID id', async () => {
    const res = await request(app)
      .patch('/api/users/me/categories/not-a-uuid')
      .set('Authorization', 'Bearer token')
      .send({ name: 'New Name' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_category_id');
    expect(mockRenameCategory).not.toHaveBeenCalled();
  });

  it('renames a category the caller owns', async () => {
    mockRenameCategory.mockResolvedValue({
      id: CATEGORY_ID,
      name: 'Fine Wine',
      slug: 'fine-wine',
      isSeed: true,
      createdAt: new Date(),
      ratingCount: 1,
    });
    const res = await request(app)
      .patch(`/api/users/me/categories/${CATEGORY_ID}`)
      .set('Authorization', 'Bearer token')
      .send({ name: 'Fine Wine' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Fine Wine');
    expect(mockRenameCategory).toHaveBeenCalledWith('user-1', CATEGORY_ID, 'Fine Wine');
  });

  it("returns 403 for another user's category", async () => {
    mockRenameCategory.mockRejectedValue(new CategoryForbiddenError());
    const res = await request(app)
      .patch(`/api/users/me/categories/${CATEGORY_ID}`)
      .set('Authorization', 'Bearer token')
      .send({ name: 'Fine Wine' });
    expect(res.status).toBe(403);
  });

  it('returns 404 for an unknown category', async () => {
    mockRenameCategory.mockRejectedValue(new CategoryNotFoundError(CATEGORY_ID));
    const res = await request(app)
      .patch(`/api/users/me/categories/${CATEGORY_ID}`)
      .set('Authorization', 'Bearer token')
      .send({ name: 'Fine Wine' });
    expect(res.status).toBe(404);
  });

  it('returns 409 duplicate_category on a rename collision', async () => {
    mockRenameCategory.mockRejectedValue(
      new DuplicateCategoryNameError('You already have a category named "Cigars"', 'cat-cigars'),
    );
    const res = await request(app)
      .patch(`/api/users/me/categories/${CATEGORY_ID}`)
      .set('Authorization', 'Bearer token')
      .send({ name: 'Cigars' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('duplicate_category');
    expect(res.body.categoryId).toBe('cat-cigars');
  });
});

describe('DELETE /api/users/me/categories/:id', () => {
  it('deletes a category the caller owns and returns 204', async () => {
    mockDeleteCategory.mockResolvedValue(undefined);
    const res = await request(app)
      .delete(`/api/users/me/categories/${CATEGORY_ID}`)
      .set('Authorization', 'Bearer token');
    expect(res.status).toBe(204);
    expect(mockDeleteCategory).toHaveBeenCalledWith('user-1', CATEGORY_ID);
  });

  it("returns 403 for another user's category, never deleting", async () => {
    mockDeleteCategory.mockRejectedValue(new CategoryForbiddenError());
    const res = await request(app)
      .delete(`/api/users/me/categories/${CATEGORY_ID}`)
      .set('Authorization', 'Bearer token');
    expect(res.status).toBe(403);
  });

  it('returns 404 for an unknown category', async () => {
    mockDeleteCategory.mockRejectedValue(new CategoryNotFoundError(CATEGORY_ID));
    const res = await request(app)
      .delete(`/api/users/me/categories/${CATEGORY_ID}`)
      .set('Authorization', 'Bearer token');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/users/me/categories/:id/merge', () => {
  it('merges the source into the target and returns the target with its updated count', async () => {
    mockMergeCategory.mockResolvedValue({
      id: TARGET_ID,
      name: 'Wine',
      slug: 'wine',
      isSeed: true,
      createdAt: new Date(),
      ratingCount: 5,
    });
    const res = await request(app)
      .post(`/api/users/me/categories/${CATEGORY_ID}/merge`)
      .set('Authorization', 'Bearer token')
      .send({ intoId: TARGET_ID });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(TARGET_ID);
    expect(mockMergeCategory).toHaveBeenCalledWith('user-1', CATEGORY_ID, TARGET_ID);
  });

  it('returns 400 self_merge when merging a category into itself', async () => {
    mockMergeCategory.mockRejectedValue(new SelfMergeError());
    const res = await request(app)
      .post(`/api/users/me/categories/${CATEGORY_ID}/merge`)
      .set('Authorization', 'Bearer token')
      .send({ intoId: CATEGORY_ID });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('self_merge');
  });

  it('returns 400 when intoId is not a UUID', async () => {
    const res = await request(app)
      .post(`/api/users/me/categories/${CATEGORY_ID}/merge`)
      .set('Authorization', 'Bearer token')
      .send({ intoId: 'not-a-uuid' });
    expect(res.status).toBe(400);
    expect(mockMergeCategory).not.toHaveBeenCalled();
  });

  it("returns 403 when the target belongs to another user", async () => {
    mockMergeCategory.mockRejectedValue(new CategoryForbiddenError());
    const res = await request(app)
      .post(`/api/users/me/categories/${CATEGORY_ID}/merge`)
      .set('Authorization', 'Bearer token')
      .send({ intoId: TARGET_ID });
    expect(res.status).toBe(403);
  });
});
