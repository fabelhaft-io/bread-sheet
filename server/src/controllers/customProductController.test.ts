import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const mockCreateCustomProduct = vi.hoisted(() => vi.fn());

const session = vi.hoisted(() => ({
  user: { id: 'user-1', email: 'test@test.com', isAnonymous: false } as
    | { id: string; email: string | undefined; isAnonymous: boolean }
    | null,
}));

vi.mock('../services/customProductService.js', async () => {
  const actual = await vi.importActual<typeof import('../services/customProductService.js')>(
    '../services/customProductService.js',
  );
  return { ...actual, createCustomProduct: mockCreateCustomProduct };
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
import { DuplicateCustomProductNameError } from '../services/customProductService.js';

function resetSession() {
  session.user = { id: 'user-1', email: 'test@test.com', isAnonymous: false };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSession();
});

describe('POST /api/custom-products', () => {
  it('returns 403 for an anonymous session, never calling the service', async () => {
    session.user = { id: 'anon-1', email: undefined, isAnonymous: true };
    const res = await request(app).post('/api/custom-products').send({ name: 'Negroni' });
    expect(res.status).toBe(403);
    expect(mockCreateCustomProduct).not.toHaveBeenCalled();
  });

  it('returns 401 with no session at all', async () => {
    session.user = null;
    const res = await request(app).post('/api/custom-products').send({ name: 'Negroni' });
    expect(res.status).toBe(401);
  });

  const VALID_IMAGE_KEY = 'processed/11111111-1111-4111-8111-111111111111.jpg';

  it('creates a PENDING_REVIEW custom product and returns 201 { id, status }', async () => {
    mockCreateCustomProduct.mockResolvedValue({ id: 'product-1', status: 'PENDING_REVIEW' });
    const res = await request(app)
      .post('/api/custom-products')
      .send({ name: 'Negroni', imageKey: VALID_IMAGE_KEY });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 'product-1', status: 'PENDING_REVIEW' });
    expect(mockCreateCustomProduct).toHaveBeenCalledWith(
      { name: 'Negroni', imageKey: VALID_IMAGE_KEY },
      'user-1',
    );
  });

  it('creates a custom product with no imageKey', async () => {
    mockCreateCustomProduct.mockResolvedValue({ id: 'product-1', status: 'PENDING_REVIEW' });
    const res = await request(app).post('/api/custom-products').send({ name: 'Negroni' });
    expect(res.status).toBe(201);
    expect(mockCreateCustomProduct).toHaveBeenCalledWith(
      { name: 'Negroni', imageKey: null },
      'user-1',
    );
  });

  it('returns 400 { message } for a missing name', async () => {
    const res = await request(app).post('/api/custom-products').send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toBeTruthy();
    expect(mockCreateCustomProduct).not.toHaveBeenCalled();
  });

  it('returns 400 for a name over 80 raw characters', async () => {
    const res = await request(app)
      .post('/api/custom-products')
      .send({ name: 'a'.repeat(81) });
    expect(res.status).toBe(400);
    expect(mockCreateCustomProduct).not.toHaveBeenCalled();
  });

  it('returns 400 for a packaged-only field (e.g. gtin)', async () => {
    const res = await request(app)
      .post('/api/custom-products')
      .send({ name: 'Negroni', gtin: '1234567890123' });
    expect(res.status).toBe(400);
    expect(mockCreateCustomProduct).not.toHaveBeenCalled();
  });

  it('returns 400 for brand (custom products have no brand)', async () => {
    const res = await request(app)
      .post('/api/custom-products')
      .send({ name: 'Negroni', brand: 'Some Bar' });
    expect(res.status).toBe(400);
    expect(mockCreateCustomProduct).not.toHaveBeenCalled();
  });

  it('returns 409 { code: duplicate_name, productId, message } on a name collision', async () => {
    mockCreateCustomProduct.mockRejectedValue(
      new DuplicateCustomProductNameError('A custom product named "Negroni" already exists', 'existing-id'),
    );
    const res = await request(app).post('/api/custom-products').send({ name: 'Negroni' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('duplicate_name');
    expect(res.body.productId).toBe('existing-id');
    expect(res.body.message).toBeTruthy();
  });
});
