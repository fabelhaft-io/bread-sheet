import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const mockProductFindFirst = vi.hoisted(() => vi.fn());
const mockPackagedFindUnique = vi.hoisted(() => vi.fn());
const mockTransaction = vi.hoisted(() => vi.fn());
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
      findFirst: mockProductFindFirst,
    },
    packagedProduct: {
      findUnique: mockPackagedFindUnique,
    },
    $transaction: mockTransaction,
    userAbuseFlag: { create: vi.fn() },
  },
}));

// Minimal stand-in for `Prisma.PrismaClientKnownRequestError` so the controller
// can `instanceof`-check the simulated unique-violation thrown in the
// concurrent-GTIN-create race test.
const FakePrismaKnownRequestError = vi.hoisted(() => {
  return class FakePrismaKnownRequestError extends Error {
    code: string;
    constructor(message: string, opts: { code: string }) {
      super(message);
      this.code = opts.code;
    }
  };
});

vi.mock('../generated/prisma_client/client.js', () => ({
  Prisma: { PrismaClientKnownRequestError: FakePrismaKnownRequestError },
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
import { ProductKind, ProductStatus } from '../generated/prisma_client/enums.js';

const VALID_GTIN = '1234567890123';
const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';

const VALIDATED_PAYLOAD = {
  gtin: VALID_GTIN,
  name: 'Sourdough Bread',
  brand: 'BakeryCo',
  genericName: 'Bread',
  energyKcal: 250,
  fat: 3.5,
  saturatedFat: 1.2,
  carbohydrates: 45,
  sugars: 5.0,
  protein: 8,
  salt: 1.2,
  servingSize: '50g',
  productImageKey: 'processed/123e4567-e89b-42d3-a456-426614174000.jpg',
  ingredients: 'Flour, water, salt, yeast',
};

function resetSession() {
  session.user = {
    id: 'user-1',
    email: 'test@test.com',
    isAnonymous: false,
  };
}

describe('GET /api/products/gtin/:gtin', () => {
  beforeEach(() => {
    mockPackagedFindUnique.mockReset();
    mockFetchFromOFF.mockReset();
    mockTransaction.mockReset();
    resetSession();
  });

  it('returns 400 for an invalid GTIN format', async () => {
    const res = await request(app)
      .get('/api/products/gtin/not-a-barcode')
      .set('Authorization', 'Bearer token');
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/invalid barcode/i);
  });

  it('returns the cached VERIFIED product with unverified: false and nested packaged', async () => {
    mockPackagedFindUnique.mockResolvedValue({
      productId: PRODUCT_ID,
      gtin: VALID_GTIN,
      genericName: null,
      energyKcal: null,
      fat: null,
      saturatedFat: null,
      carbohydrates: null,
      sugars: null,
      protein: null,
      salt: null,
      servingSize: null,
      ingredients: null,
      product: {
        id: PRODUCT_ID,
        kind: ProductKind.PACKAGED,
        name: 'Sourdough',
        brand: null,
        image: null,
        description: null,
        status: ProductStatus.VERIFIED,
        submittedByUserId: null,
      },
    });

    const res = await request(app)
      .get(`/api/products/gtin/${VALID_GTIN}`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(PRODUCT_ID);
    expect(res.body.unverified).toBe(false);
    expect(res.body.packaged.gtin).toBe(VALID_GTIN);
    expect(mockFetchFromOFF).not.toHaveBeenCalled();
  });

  it('fetches from OFF, caches Product + PackagedProduct in one transaction, and returns the product', async () => {
    const offData = {
      gtin: VALID_GTIN,
      name: 'Ciabatta',
      brand: null,
      image: null,
      description: null,
    };
    mockPackagedFindUnique.mockResolvedValue(null);
    mockFetchFromOFF.mockResolvedValue(offData);

    const createdProduct = {
      id: PRODUCT_ID,
      kind: ProductKind.PACKAGED,
      name: 'Ciabatta',
      brand: null,
      image: null,
      description: null,
      status: ProductStatus.VERIFIED,
      submittedByUserId: null,
    };
    const createdPackaged = { productId: PRODUCT_ID, gtin: VALID_GTIN };
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        product: { create: vi.fn().mockResolvedValue(createdProduct) },
        packagedProduct: { create: vi.fn().mockResolvedValue(createdPackaged) },
      };
      return fn(tx);
    });

    const res = await request(app)
      .get(`/api/products/gtin/${VALID_GTIN}`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(PRODUCT_ID);
    expect(res.body.unverified).toBe(false);
    expect(res.body.packaged.gtin).toBe(VALID_GTIN);
  });

  it('re-reads instead of erroring when two scans race to create the same new GTIN (P2002)', async () => {
    mockPackagedFindUnique.mockResolvedValueOnce(null); // first cache check: miss
    mockFetchFromOFF.mockResolvedValue({
      gtin: VALID_GTIN,
      name: 'Ciabatta',
      brand: null,
      image: null,
      description: null,
    });
    mockTransaction.mockRejectedValue(
      new FakePrismaKnownRequestError('Unique constraint failed', { code: 'P2002' }),
    );
    // Re-read after the race: the other request's row.
    mockPackagedFindUnique.mockResolvedValueOnce({
      productId: PRODUCT_ID,
      gtin: VALID_GTIN,
      genericName: null,
      energyKcal: null,
      fat: null,
      saturatedFat: null,
      carbohydrates: null,
      sugars: null,
      protein: null,
      salt: null,
      servingSize: null,
      ingredients: null,
      product: {
        id: PRODUCT_ID,
        kind: ProductKind.PACKAGED,
        name: 'Ciabatta',
        brand: null,
        image: null,
        description: null,
        status: ProductStatus.VERIFIED,
        submittedByUserId: null,
      },
    });

    const res = await request(app)
      .get(`/api/products/gtin/${VALID_GTIN}`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(PRODUCT_ID);
  });

  it('returns unverified: true and a flat submission block for a PENDING_REVIEW product', async () => {
    mockPackagedFindUnique.mockResolvedValue({
      productId: PRODUCT_ID,
      gtin: VALID_GTIN,
      genericName: 'Bread',
      energyKcal: 250,
      fat: 3,
      saturatedFat: 1.0,
      carbohydrates: 45,
      sugars: 4.0,
      protein: 8,
      salt: 1,
      servingSize: '50g',
      ingredients: 'flour, water',
      product: {
        id: PRODUCT_ID,
        kind: ProductKind.PACKAGED,
        name: 'Mystery Bread',
        brand: 'Artisan',
        image: 'https://s3/img.jpg',
        description: null,
        status: ProductStatus.PENDING_REVIEW,
        submittedByUserId: 'user-42',
      },
    });

    const res = await request(app)
      .get(`/api/products/gtin/${VALID_GTIN}`)
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
    expect(res.body.submission).not.toHaveProperty('productImageKey');
  });

  // P5-007: anonymous callers used to get a 404 here. They now see the product
  // behind the same "unverified" payload registered users get — minus the
  // submitter's user id, which is of no use to a session that cannot submit.
  it('returns a PENDING_REVIEW product to an anonymous caller, without submittedByUserId', async () => {
    session.user = { id: 'anon-1', email: undefined, isAnonymous: true };
    mockPackagedFindUnique.mockResolvedValue({
      productId: PRODUCT_ID,
      gtin: VALID_GTIN,
      genericName: 'Bread',
      energyKcal: 250,
      fat: 3,
      saturatedFat: 1.0,
      carbohydrates: 45,
      sugars: 4.0,
      protein: 8,
      salt: 1,
      servingSize: '50g',
      ingredients: 'flour, water',
      product: {
        id: PRODUCT_ID,
        kind: ProductKind.PACKAGED,
        name: 'Mystery Bread',
        brand: 'Artisan',
        image: null,
        description: null,
        status: ProductStatus.PENDING_REVIEW,
        submittedByUserId: 'user-42',
      },
    });

    const res = await request(app)
      .get(`/api/products/gtin/${VALID_GTIN}`)
      .set('Authorization', 'Bearer anon-token');

    expect(res.status).toBe(200);
    expect(res.body.unverified).toBe(true);
    expect(res.body).not.toHaveProperty('submittedByUserId');
    expect(mockFetchFromOFF).not.toHaveBeenCalled();
  });

  it('returns 404 for a REJECTED product to a registered caller', async () => {
    mockPackagedFindUnique.mockResolvedValue({
      productId: PRODUCT_ID,
      gtin: VALID_GTIN,
      product: {
        id: PRODUCT_ID,
        kind: ProductKind.PACKAGED,
        name: 'Bad Bread',
        status: ProductStatus.REJECTED,
        submittedByUserId: 'user-42',
      },
    });

    const res = await request(app)
      .get(`/api/products/gtin/${VALID_GTIN}`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(404);
    expect(mockFetchFromOFF).not.toHaveBeenCalled();
  });

  it('returns 404 when OFF does not recognise the GTIN', async () => {
    mockPackagedFindUnique.mockResolvedValue(null);
    mockFetchFromOFF.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/products/gtin/${VALID_GTIN}`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(404);
  });
});

describe('GET /api/products/:productId', () => {
  beforeEach(() => {
    mockProductFindFirst.mockReset();
    resetSession();
  });

  it('returns 400 for a non-UUID productId', async () => {
    const res = await request(app)
      .get('/api/products/not-a-uuid')
      .set('Authorization', 'Bearer token');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_product_id');
    expect(mockProductFindFirst).not.toHaveBeenCalled();
  });

  it('returns the serialized product', async () => {
    mockProductFindFirst.mockResolvedValue({
      id: PRODUCT_ID,
      kind: ProductKind.PACKAGED,
      name: 'Sourdough',
      brand: null,
      image: null,
      description: null,
      status: ProductStatus.VERIFIED,
      submittedByUserId: null,
      packaged: {
        gtin: VALID_GTIN,
        genericName: null,
        energyKcal: null,
        fat: null,
        saturatedFat: null,
        carbohydrates: null,
        sugars: null,
        protein: null,
        salt: null,
        servingSize: null,
        ingredients: null,
      },
    });

    const res = await request(app)
      .get(`/api/products/${PRODUCT_ID}`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: PRODUCT_ID,
      kind: ProductKind.PACKAGED,
      name: 'Sourdough',
      brand: null,
      image: null,
      description: null,
      status: ProductStatus.VERIFIED,
      unverified: false,
      submittedByUserId: null,
      packaged: {
        gtin: VALID_GTIN,
        genericName: null,
        energyKcal: null,
        fat: null,
        saturatedFat: null,
        carbohydrates: null,
        sugars: null,
        protein: null,
        salt: null,
        servingSize: null,
        ingredients: null,
      },
    });
    // `visibleProductWhere` filtering happens inside the `where` clause itself.
    expect(mockProductFindFirst).toHaveBeenCalledWith({
      where: { id: PRODUCT_ID, status: { not: ProductStatus.REJECTED } },
      include: { packaged: true },
    });
  });

  it('returns null packaged for a CUSTOM product', async () => {
    mockProductFindFirst.mockResolvedValue({
      id: PRODUCT_ID,
      kind: ProductKind.CUSTOM,
      name: 'Whisky Sour',
      brand: null,
      image: null,
      description: null,
      status: ProductStatus.VERIFIED,
      submittedByUserId: null,
      packaged: null,
    });

    const res = await request(app)
      .get(`/api/products/${PRODUCT_ID}`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body.packaged).toBeNull();
  });

  it('returns 404 for a REJECTED product (visibility rule filters it out of the query)', async () => {
    // `visibleProductWhere` is baked into the `where` clause, so a REJECTED
    // row simply isn't returned by the (mocked) database.
    mockProductFindFirst.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/products/${PRODUCT_ID}`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(404);
  });

  it('returns 404 for an unknown product', async () => {
    mockProductFindFirst.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/products/${PRODUCT_ID}`)
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

  it('returns 201 with { id, gtin, status } when the service reports a new submission', async () => {
    mockValidateProductSubmission.mockReturnValue(VALIDATED_PAYLOAD);
    mockCreateSubmittedProduct.mockResolvedValue({
      action: 'created',
      product: {
        id: PRODUCT_ID,
        gtin: VALID_GTIN,
        status: ProductStatus.PENDING_REVIEW,
      },
    });

    const res = await request(app)
      .post('/api/products')
      .set('Authorization', 'Bearer token')
      .send(VALIDATED_PAYLOAD);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: PRODUCT_ID,
      gtin: VALID_GTIN,
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
        id: PRODUCT_ID,
        gtin: VALID_GTIN,
        status: ProductStatus.PENDING_REVIEW,
      },
    });

    const res = await request(app)
      .post('/api/products')
      .set('Authorization', 'Bearer token')
      .send(VALIDATED_PAYLOAD);

    expect(res.status).toBe(200);
    expect(res.body.gtin).toBe(VALID_GTIN);
  });

  it('returns 422 with the field and reason when validation fails', async () => {
    mockValidateProductSubmission.mockImplementation(() => {
      throw new SubmissionValidationError('name', 'name is required');
    });

    const res = await request(app)
      .post('/api/products')
      .set('Authorization', 'Bearer token')
      .send({ gtin: VALID_GTIN });

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
      new ProductAlreadyVerifiedError(VALID_GTIN),
    );

    const res = await request(app)
      .post('/api/products')
      .set('Authorization', 'Bearer token')
      .send(VALIDATED_PAYLOAD);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('product_already_verified');
  });

  it('returns 409 when another user already has a pending submission for the GTIN', async () => {
    mockValidateProductSubmission.mockReturnValue(VALIDATED_PAYLOAD);
    mockCreateSubmittedProduct.mockRejectedValue(
      new ProductPendingByAnotherUserError(VALID_GTIN),
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
      new ProductPreviouslyRejectedError(VALID_GTIN),
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
