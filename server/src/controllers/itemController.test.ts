import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const mockItemCreate = vi.hoisted(() => vi.fn());
const mockItemFindMany = vi.hoisted(() => vi.fn());
const mockItemFindUnique = vi.hoisted(() => vi.fn());
const mockItemUpdate = vi.hoisted(() => vi.fn());
const mockItemDelete = vi.hoisted(() => vi.fn());

vi.mock('../db.js', () => ({
  default: {
    item: {
      create: mockItemCreate,
      findMany: mockItemFindMany,
      findUnique: mockItemFindUnique,
      update: mockItemUpdate,
      delete: mockItemDelete,
    },
  },
}));

// app.ts loads all routes including userRoutes, which imports authMiddleware at module
// level — mock it here to prevent createClient() from requiring a real Supabase URL.
vi.mock('../middlewares/authMiddleware.js', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireRegistered: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../middlewares/rateLimit.js', () => ({
  apiLimiter: (_req: any, _res: any, next: any) => next(),
  userLimiter: (_req: any, _res: any, next: any) => next(),
  syncLimiter: (_req: any, _res: any, next: any) => next(),
}));

import app from '../app.js';

const ITEM = { id: 1, name: 'Baguette' };

describe('Item CRUD — /api/items', () => {
  beforeEach(() => {
    mockItemCreate.mockReset();
    mockItemFindMany.mockReset();
    mockItemFindUnique.mockReset();
    mockItemUpdate.mockReset();
    mockItemDelete.mockReset();
  });

  describe('POST /api/items', () => {
    it('creates and returns the new item with status 201', async () => {
      mockItemCreate.mockResolvedValue(ITEM);
      const res = await request(app).post('/api/items').send({ name: 'Baguette' });
      expect(res.status).toBe(201);
      expect(res.body).toEqual(ITEM);
    });
  });

  describe('GET /api/items', () => {
    it('returns all items', async () => {
      mockItemFindMany.mockResolvedValue([ITEM]);
      const res = await request(app).get('/api/items');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([ITEM]);
    });
  });

  describe('GET /api/items/:id', () => {
    it('returns the item when it exists', async () => {
      mockItemFindUnique.mockResolvedValue(ITEM);
      const res = await request(app).get('/api/items/1');
      expect(res.status).toBe(200);
      expect(res.body).toEqual(ITEM);
    });

    it('returns 404 when the item does not exist', async () => {
      mockItemFindUnique.mockResolvedValue(null);
      const res = await request(app).get('/api/items/99');
      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/items/:id', () => {
    it('updates and returns the item', async () => {
      const updated = { id: 1, name: 'Ciabatta' };
      mockItemFindUnique.mockResolvedValue(ITEM);
      mockItemUpdate.mockResolvedValue(updated);
      const res = await request(app).put('/api/items/1').send({ name: 'Ciabatta' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual(updated);
    });

    it('returns 404 when the item does not exist', async () => {
      mockItemFindUnique.mockResolvedValue(null);
      const res = await request(app).put('/api/items/99').send({ name: 'Ciabatta' });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/items/:id', () => {
    it('deletes and returns the removed item', async () => {
      mockItemFindUnique.mockResolvedValue(ITEM);
      mockItemDelete.mockResolvedValue(ITEM);
      const res = await request(app).delete('/api/items/1');
      expect(res.status).toBe(200);
      expect(res.body).toEqual(ITEM);
    });

    it('returns 404 when the item does not exist', async () => {
      mockItemFindUnique.mockResolvedValue(null);
      const res = await request(app).delete('/api/items/99');
      expect(res.status).toBe(404);
    });
  });
});
