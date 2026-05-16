import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const mockFindUnique = vi.hoisted(() => vi.fn());
const mockCreate = vi.hoisted(() => vi.fn());
const mockFetchFromOFF = vi.hoisted(() => vi.fn());
const mockCreateSubmittedProduct = vi.hoisted(() => vi.fn());
const mockValidateProductSubmission = vi.hoisted(() => vi.fn());

// Mutable per-test "session". The mocked requireAuth/requireRegistered both
// read from this so individual tests can simulate registered vs anonymous
// users without re-mocking the module.
const session = vi.hoisted(() => ({
  user: { id: 'user-1', email: 'test@test.com', isAnonymous: false } as
    | { id: string; email: string | undefined; isAnonymous: boolean }
    | null,
}));

vi.mock('../db.js', () => ({
  default: {
    product: {
      findUnique: mockFindUnique,
      create: mockCreate,
    },
  },
}));

vi.mock('../services/productService.js', async () => {
  // Pull real error classes so `instanceof` checks in the controller match.
  const actual = await vi.importActual<
    typeof import('./../services/productService.js')
  >('../services/productService.js');
  return {
    ...actual,
    fetchFromOpenFoodFacts: mockFetchFromOFF,
    createSubmittedProduct: mockCreateSubmittedProduct,
  };
});

vi.mock('../validators/productSubmissionValidator.js', async () => {
  const actual = await vi.importActual<
    typeof import('./../validators/productSubmissionValidator.js')
  >('../validators/productSubmissionValidator.js');
  return {
    ...actual,
    validateProductSubmission: mockValidateProductSubmission,
  };
});

vi.mock('../middlewares/authMiddleware.js', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (!session.user) {
      return res.status(401).json({ error: 'unauthorised' });
    }
    req.user = session.user;
    next();
  },
  requireRegistered: (req: any, res: any, next: any) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (req.user.isAnonymous) {
      return res.status(403).json({ error: 'Registration required' });
    }
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
  ProductAlreadyVerifiedError,
  ProductPendingByAnotherUserError,
  ProductPreviouslyRejectedError,
} from '../services/productService.js';
import { SubmissionValidationError } from '../validators/productSubmissionValidator.js';
import { ProductStatus } from '../generated/prisma_client/enums.js';

const VALID_BARCODE = '1234567890123';

const VALIDATED_PAYLOAD = {
  barcode: VALID_BARCODE,
  name: 'Sourdough Bread',
  brand: 'BakeryCo',
  genericName: 'Bread',
  energyKcal: 250,
  carbohydrates: 45,
  fat: 3.5,
  protein: 8,
  salt: 1.2,
  servingSize: '50g',
  productImageUrl: 'https://s3.example.com/submissions/abc.jpg',
  ingredients: 'Flour, water, salt, yeast',
};

function resetSession() {
  session.user = {
    id: 'user-1',
    email: 'test@test.com',
    isAnonymous: false,
  };
}

describe('GET /api/products/:barcode', () => {
  beforeEach(() => {
    mockFindUnique.mockReset();
    mockCreate.mockReset();
    mockFetchFromOFF.mockReset();
    resetSession();
  });

  it('returns 400 for an invalid barcode format', async () => {
    const res = await request(app)
      .get('/api/products/not-a-barcode')
      .set('Authorization', 'Bearer token');
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/invalid barcode/i);
  });

  it('returns the cached VERIFIED product with unverified: false', async () => {
    const product = { id: 1, barcode: VALID_BARCODE, name: 'Sourdough', status: ProductStatus.VERIFIED };
    mockFindUnique.mockResolvedValue(product);

    const res = await request(app)
      .get(`/api/products/${VALID_BARCODE}`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...product, unverified: false });
    expect(mockFetchFromOFF).not.toHaveBeenCalled();
  });

  it('fetches from OFF, caches in DB, and returns the product with unverified: false', async () => {
    const offData = {
      barcode: VALID_BARCODE,
      name: 'Ciabatta',
      brand: null,
      image: null,
      description: null,
    };
    const saved = { id: 2, ...offData, status: ProductStatus.VERIFIED };
    mockFindUnique.mockResolvedValue(null);
    mockFetchFromOFF.mockResolvedValue(offData);
    mockCreate.mockResolvedValue(saved);

    const res = await request(app)
      .get(`/api/products/${VALID_BARCODE}`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...saved, unverified: false });
    expect(mockCreate).toHaveBeenCalledWith({ data: offData });
  });

  it('returns unverified: true and a submission block for a PENDING_REVIEW product', async () => {
    const product = {
      id: 'p1',
      barcode: VALID_BARCODE,
      name: 'Mystery Bread',
      brand: 'Artisan',
      image: 'https://s3/img.jpg',
      description: null,
      status: ProductStatus.PENDING_REVIEW,
      submittedByUserId: 'user-42',
      genericName: 'Bread',
      energyKcal: 250,
      carbohydrates: 45,
      fat: 3,
      protein: 8,
      salt: 1,
      servingSize: '50g',
      ingredients: 'flour, water',
    };
    mockFindUnique.mockResolvedValue(product);

    const res = await request(app)
      .get(`/api/products/${VALID_BARCODE}`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body.unverified).toBe(true);
    expect(res.body.submittedByUserId).toBe('user-42');
    expect(res.body.submission).toMatchObject({
      name: 'Mystery Bread',
      brand: 'Artisan',
      genericName: 'Bread',
      energyKcal: 250,
    });
    expect(res.body.submission).not.toHaveProperty('productImageUrl');
  });

  it('returns 404 for a PENDING_REVIEW product when the caller is anonymous', async () => {
    session.user = { id: 'anon-1', email: undefined, isAnonymous: true };
    mockFindUnique.mockResolvedValue({
      id: 'p1',
      barcode: VALID_BARCODE,
      name: 'Mystery Bread',
      status: ProductStatus.PENDING_REVIEW,
      submittedByUserId: 'user-42',
    });

    const res = await request(app)
      .get(`/api/products/${VALID_BARCODE}`)
      .set('Authorization', 'Bearer anon-token');

    expect(res.status).toBe(404);
    expect(mockFetchFromOFF).not.toHaveBeenCalled();
  });

  it('returns unverified: true without a submission block for a REJECTED product', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'p1',
      barcode: VALID_BARCODE,
      name: 'Bad Bread',
      status: ProductStatus.REJECTED,
      submittedByUserId: 'user-42',
      genericName: null,
      energyKcal: null,
      carbohydrates: null,
      fat: null,
      protein: null,
      salt: null,
      servingSize: null,
      ingredients: null,
    });

    const res = await request(app)
      .get(`/api/products/${VALID_BARCODE}`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body.unverified).toBe(true);
    expect(res.body.submission).toBeDefined();
  });

  it('returns 404 when OFF does not recognise the barcode', async () => {
    mockFindUnique.mockResolvedValue(null);
    mockFetchFromOFF.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/products/${VALID_BARCODE}`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(404);
  });
});

describe('POST /api/products', () => {
  beforeEach(() => {
    mockCreateSubmittedProduct.mockReset();
    mockValidateProductSubmission.mockReset();
    resetSession();
  });

  it('returns 201 with the product body when the service reports a new submission', async () => {
    mockValidateProductSubmission.mockReturnValue(VALIDATED_PAYLOAD);
    mockCreateSubmittedProduct.mockResolvedValue({
      action: 'created',
      product: {
        barcode: VALID_BARCODE,
        status: ProductStatus.PENDING_REVIEW,
      },
    });

    const res = await request(app)
      .post('/api/products')
      .set('Authorization', 'Bearer token')
      .send(VALIDATED_PAYLOAD);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      barcode: VALID_BARCODE,
      status: ProductStatus.PENDING_REVIEW,
    });

    expect(mockValidateProductSubmission).toHaveBeenCalledTimes(1);
    expect(mockCreateSubmittedProduct).toHaveBeenCalledWith(
      VALIDATED_PAYLOAD,
      'user-1',
    );
  });

  it('returns 200 with the product body when the service reports an update', async () => {
    mockValidateProductSubmission.mockReturnValue(VALIDATED_PAYLOAD);
    mockCreateSubmittedProduct.mockResolvedValue({
      action: 'updated',
      product: {
        barcode: VALID_BARCODE,
        status: ProductStatus.PENDING_REVIEW,
      },
    });

    const res = await request(app)
      .post('/api/products')
      .set('Authorization', 'Bearer token')
      .send(VALIDATED_PAYLOAD);

    expect(res.status).toBe(200);
    expect(res.body.barcode).toBe(VALID_BARCODE);
  });

  it('returns 422 with the field and reason when validation fails', async () => {
    mockValidateProductSubmission.mockImplementation(() => {
      throw new SubmissionValidationError('name', 'name is required');
    });

    const res = await request(app)
      .post('/api/products')
      .set('Authorization', 'Bearer token')
      .send({ barcode: VALID_BARCODE });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      field: 'name',
      reason: 'name is required',
      error: 'name is required',
    });
    expect(mockCreateSubmittedProduct).not.toHaveBeenCalled();
  });

  it('returns 409 when the product is already VERIFIED', async () => {
    mockValidateProductSubmission.mockReturnValue(VALIDATED_PAYLOAD);
    mockCreateSubmittedProduct.mockRejectedValue(
      new ProductAlreadyVerifiedError(VALID_BARCODE),
    );

    const res = await request(app)
      .post('/api/products')
      .set('Authorization', 'Bearer token')
      .send(VALIDATED_PAYLOAD);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('product_already_verified');
  });

  it('returns 409 when another user already has a pending submission for the barcode', async () => {
    mockValidateProductSubmission.mockReturnValue(VALIDATED_PAYLOAD);
    mockCreateSubmittedProduct.mockRejectedValue(
      new ProductPendingByAnotherUserError(VALID_BARCODE),
    );

    const res = await request(app)
      .post('/api/products')
      .set('Authorization', 'Bearer token')
      .send(VALIDATED_PAYLOAD);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('submission_pending');
  });

  it('returns 409 when the original submitter retries a previously rejected product', async () => {
    mockValidateProductSubmission.mockReturnValue(VALIDATED_PAYLOAD);
    mockCreateSubmittedProduct.mockRejectedValue(
      new ProductPreviouslyRejectedError(VALID_BARCODE),
    );

    const res = await request(app)
      .post('/api/products')
      .set('Authorization', 'Bearer token')
      .send(VALIDATED_PAYLOAD);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('product_previously_rejected');
  });

  it('forwards unexpected errors to the central error handler (500)', async () => {
    mockValidateProductSubmission.mockReturnValue(VALIDATED_PAYLOAD);
    mockCreateSubmittedProduct.mockRejectedValue(new Error('boom'));

    const res = await request(app)
      .post('/api/products')
      .set('Authorization', 'Bearer token')
      .send(VALIDATED_PAYLOAD);

    expect(res.status).toBe(500);
  });

  it('returns 403 when the caller is an anonymous user', async () => {
    session.user = {
      id: 'anon-1',
      email: undefined,
      isAnonymous: true,
    };
    mockValidateProductSubmission.mockReturnValue(VALIDATED_PAYLOAD);

    const res = await request(app)
      .post('/api/products')
      .set('Authorization', 'Bearer anon-token')
      .send(VALIDATED_PAYLOAD);

    expect(res.status).toBe(403);
    expect(mockCreateSubmittedProduct).not.toHaveBeenCalled();
    expect(mockValidateProductSubmission).not.toHaveBeenCalled();
  });

  it('returns 401 when no session is present', async () => {
    session.user = null;

    const res = await request(app)
      .post('/api/products')
      .send(VALIDATED_PAYLOAD);

    expect(res.status).toBe(401);
    expect(mockCreateSubmittedProduct).not.toHaveBeenCalled();
  });
});