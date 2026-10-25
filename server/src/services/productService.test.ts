import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockTxPackagedFindUnique = vi.hoisted(() => vi.fn());
const mockTxPackagedCreate = vi.hoisted(() => vi.fn());
const mockTxPackagedUpdate = vi.hoisted(() => vi.fn());
const mockTxProductCreate = vi.hoisted(() => vi.fn());
const mockTxProductUpdate = vi.hoisted(() => vi.fn());
const mockTxVerificationDeleteMany = vi.hoisted(() => vi.fn());
const mockTransaction = vi.hoisted(() =>
  vi.fn(
    async <T>(fn: (tx: Record<string, unknown>) => Promise<T>): Promise<T> => {
      const tx = {
        packagedProduct: {
          findUnique: mockTxPackagedFindUnique,
          create: mockTxPackagedCreate,
          update: mockTxPackagedUpdate,
        },
        product: {
          create: mockTxProductCreate,
          update: mockTxProductUpdate,
        },
        productVerification: {
          deleteMany: mockTxVerificationDeleteMany,
        },
      };
      return fn(tx);
    },
  ),
);

vi.mock('../db.js', () => ({
  default: {
    $transaction: mockTransaction,
  },
}));

// Minimal stand-in for `Prisma.PrismaClientKnownRequestError` so the service
// can `instanceof`-check the simulated unique-violation thrown in tests.
// Defined via vi.hoisted so it exists when the vi.mock factory runs.
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

import {
  fetchFromOpenFoodFacts,
  createSubmittedProduct,
  ProductAlreadyVerifiedError,
  ProductPendingByAnotherUserError,
  ProductPreviouslyRejectedError,
  type ProductSubmissionInput,
} from './productService.js';
import { ProductStatus } from '../generated/prisma_client/enums.js';

function makeResponse(
  body: object,
  ok = true,
  status = 200,
): Promise<Response> {
  return Promise.resolve({
    ok,
    status,
    statusText: ok ? 'OK' : 'Internal Server Error',
    json: () => Promise.resolve(body),
  } as Response);
}

describe('fetchFromOpenFoodFacts', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when OFF reports product not found (status 0)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(makeResponse({ status: 0 })));
    await expect(fetchFromOpenFoodFacts('1234567890123')).resolves.toBeNull();
  });

  it('returns null when OFF response has no product field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(makeResponse({ status: 1 })));
    await expect(fetchFromOpenFoodFacts('1234567890123')).resolves.toBeNull();
  });

  it('maps all product fields correctly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValue(
        makeResponse({
          status: 1,
          product: {
            product_name: '  Sourdough Bread  ',
            brands: 'BakeryCo',
            image_url: 'https://example.com/img.jpg',
            generic_name: 'Bread',
          },
        }),
      ),
    );

    const result = await fetchFromOpenFoodFacts('1234567890123');
    expect(result).toEqual({
      gtin: '1234567890123',
      name: 'Sourdough Bread',
      brand: 'BakeryCo',
      image: 'https://example.com/img.jpg',
      description: 'Bread',
    });
  });

  it('uses "Unknown Product" fallback and null fields when product data is sparse', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValue(
        makeResponse({
          status: 1,
          product: { product_name: '' },
        }),
      ),
    );

    const result = await fetchFromOpenFoodFacts('1234567890123');
    expect(result?.name).toBe('Unknown Product');
    expect(result?.brand).toBeNull();
    expect(result?.image).toBeNull();
    expect(result?.description).toBeNull();
  });

  it('throws when the OFF API returns a non-ok HTTP response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(makeResponse({}, false, 503)));
    await expect(fetchFromOpenFoodFacts('1234567890123')).rejects.toThrow(
      'Open Food Facts API error: 503',
    );
  });

  it('returns null (does not throw) when OFF returns HTTP 404 for an unknown GTIN', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValue(makeResponse({}, false, 404)),
    );
    await expect(fetchFromOpenFoodFacts('4016548067272')).resolves.toBeNull();
  });
});

const VALID_INPUT: ProductSubmissionInput = {
  gtin: '1234567890123',
  name: 'Sourdough Bread',
  brand: 'BakeryCo',
  genericName: 'Bread',
  energyKcal: 250,
  fat: 3.5,
  saturatedFat: 1.2,
  carbohydrates: 45,
  sugars: 3.0,
  protein: 8,
  salt: 1.2,
  servingSize: '50g',
  productImageKey: 'processed/123e4567-e89b-42d3-a456-426614174000.jpg',
  ingredients: 'Flour, water, salt, yeast',
};

describe('createSubmittedProduct', () => {
  beforeEach(() => {
    mockTxPackagedFindUnique.mockReset();
    mockTxPackagedCreate.mockReset();
    mockTxPackagedUpdate.mockReset();
    mockTxProductCreate.mockReset();
    mockTxProductUpdate.mockReset();
    mockTxVerificationDeleteMany.mockReset();
    mockTransaction.mockClear();
  });

  it('throws ProductAlreadyVerifiedError when the GTIN is already VERIFIED', async () => {
    mockTxPackagedFindUnique.mockResolvedValue({
      productId: 'p1',
      gtin: VALID_INPUT.gtin,
      product: {
        id: 'p1',
        status: ProductStatus.VERIFIED,
        submittedByUserId: 'other-user',
      },
    });

    await expect(
      createSubmittedProduct(VALID_INPUT, 'user-1'),
    ).rejects.toBeInstanceOf(ProductAlreadyVerifiedError);

    expect(mockTxProductCreate).not.toHaveBeenCalled();
    expect(mockTxProductUpdate).not.toHaveBeenCalled();
  });

  it('throws ProductPreviouslyRejectedError when the original submitter resubmits a REJECTED product', async () => {
    mockTxPackagedFindUnique.mockResolvedValue({
      productId: 'p1',
      gtin: VALID_INPUT.gtin,
      product: {
        id: 'p1',
        status: ProductStatus.REJECTED,
        submittedByUserId: 'user-1',
      },
    });

    await expect(
      createSubmittedProduct(VALID_INPUT, 'user-1'),
    ).rejects.toBeInstanceOf(ProductPreviouslyRejectedError);

    expect(mockTxProductCreate).not.toHaveBeenCalled();
    expect(mockTxProductUpdate).not.toHaveBeenCalled();
  });

  it('a different user resubmitting a REJECTED product overwrites both rows and resets verifications', async () => {
    mockTxPackagedFindUnique.mockResolvedValue({
      productId: 'p1',
      gtin: VALID_INPUT.gtin,
      product: {
        id: 'p1',
        status: ProductStatus.REJECTED,
        submittedByUserId: 'original-user',
      },
    });
    mockTxVerificationDeleteMany.mockResolvedValue({ count: 2 });
    mockTxProductUpdate.mockResolvedValue({
      id: 'p1',
      status: ProductStatus.PENDING_REVIEW,
    });
    mockTxPackagedUpdate.mockResolvedValue({});

    const result = await createSubmittedProduct(VALID_INPUT, 'user-2');

    expect(result).toEqual({
      action: 'updated',
      product: { id: 'p1', gtin: VALID_INPUT.gtin, status: ProductStatus.PENDING_REVIEW },
    });

    expect(mockTxVerificationDeleteMany).toHaveBeenCalledWith({
      where: { productId: 'p1' },
    });
    expect(mockTxProductUpdate).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: expect.objectContaining({
        name: VALID_INPUT.name,
        brand: VALID_INPUT.brand,
        image: VALID_INPUT.productImageKey,
        status: ProductStatus.PENDING_REVIEW,
        submittedByUserId: 'user-2',
      }),
    });
    expect(mockTxPackagedUpdate).toHaveBeenCalledWith({
      where: { productId: 'p1' },
      data: expect.objectContaining({ genericName: VALID_INPUT.genericName }),
    });
  });

  it('throws ProductPendingByAnotherUserError when a different user already has a PENDING_REVIEW submission', async () => {
    mockTxPackagedFindUnique.mockResolvedValue({
      productId: 'p1',
      gtin: VALID_INPUT.gtin,
      product: {
        id: 'p1',
        status: ProductStatus.PENDING_REVIEW,
        submittedByUserId: 'other-user',
      },
    });

    await expect(
      createSubmittedProduct(VALID_INPUT, 'user-1'),
    ).rejects.toBeInstanceOf(ProductPendingByAnotherUserError);

    expect(mockTxProductCreate).not.toHaveBeenCalled();
    expect(mockTxProductUpdate).not.toHaveBeenCalled();
  });

  it('same user re-submitting their own PENDING_REVIEW product updates both tables and resets verifications', async () => {
    mockTxPackagedFindUnique.mockResolvedValue({
      productId: 'p1',
      gtin: VALID_INPUT.gtin,
      product: {
        id: 'p1',
        status: ProductStatus.PENDING_REVIEW,
        submittedByUserId: 'user-1',
      },
    });
    mockTxVerificationDeleteMany.mockResolvedValue({ count: 1 });
    mockTxProductUpdate.mockResolvedValue({
      id: 'p1',
      status: ProductStatus.PENDING_REVIEW,
    });
    mockTxPackagedUpdate.mockResolvedValue({});

    const result = await createSubmittedProduct(VALID_INPUT, 'user-1');

    expect(result).toEqual({
      action: 'updated',
      product: { id: 'p1', gtin: VALID_INPUT.gtin, status: ProductStatus.PENDING_REVIEW },
    });

    expect(mockTxVerificationDeleteMany).toHaveBeenCalledWith({
      where: { productId: 'p1' },
    });
    // Same-user update keeps the submitter — does NOT pass submittedByUserId
    const updateArg = mockTxProductUpdate.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: 'p1' });
    expect(updateArg.data).not.toHaveProperty('submittedByUserId');
    expect(updateArg.data).not.toHaveProperty('status');
    expect(updateArg.data.name).toBe(VALID_INPUT.name);
  });

  it('creates a brand-new PENDING_REVIEW Product + PackagedProduct when no row exists for the GTIN', async () => {
    mockTxPackagedFindUnique.mockResolvedValue(null);
    mockTxProductCreate.mockResolvedValue({
      id: 'p2',
      status: ProductStatus.PENDING_REVIEW,
    });
    mockTxPackagedCreate.mockResolvedValue({});

    const result = await createSubmittedProduct(VALID_INPUT, 'user-1');

    expect(result).toEqual({
      action: 'created',
      product: { id: 'p2', gtin: VALID_INPUT.gtin, status: ProductStatus.PENDING_REVIEW },
    });

    expect(mockTxProductCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'PACKAGED',
        name: VALID_INPUT.name,
        image: VALID_INPUT.productImageKey,
        status: ProductStatus.PENDING_REVIEW,
        submittedByUserId: 'user-1',
      }),
    });
    expect(mockTxPackagedCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        productId: 'p2',
        gtin: VALID_INPUT.gtin,
        genericName: VALID_INPUT.genericName,
        energyKcal: VALID_INPUT.energyKcal,
      }),
    });
  });

  it('maps every payload field correctly when creating a new product', async () => {
    mockTxPackagedFindUnique.mockResolvedValue(null);
    mockTxProductCreate.mockResolvedValue({
      id: 'p3',
      status: ProductStatus.PENDING_REVIEW,
    });
    mockTxPackagedCreate.mockResolvedValue({});

    await createSubmittedProduct(VALID_INPUT, 'user-1');

    const productCreateArg = mockTxProductCreate.mock.calls[0][0];
    expect(productCreateArg.data).toMatchObject({
      kind: 'PACKAGED',
      name: VALID_INPUT.name,
      brand: VALID_INPUT.brand,
      image: VALID_INPUT.productImageKey,
      status: ProductStatus.PENDING_REVIEW,
      submittedByUserId: 'user-1',
    });
    // The schema field is `image`, not `productImageKey` — make sure we don't leak the wire name
    expect(productCreateArg.data).not.toHaveProperty('productImageKey');
    // `gtin` lives on PackagedProduct, not Product.
    expect(productCreateArg.data).not.toHaveProperty('gtin');

    const packagedCreateArg = mockTxPackagedCreate.mock.calls[0][0];
    expect(packagedCreateArg.data).toMatchObject({
      productId: 'p3',
      gtin: VALID_INPUT.gtin,
      genericName: VALID_INPUT.genericName,
      energyKcal: VALID_INPUT.energyKcal,
      carbohydrates: VALID_INPUT.carbohydrates,
      fat: VALID_INPUT.fat,
      protein: VALID_INPUT.protein,
      salt: VALID_INPUT.salt,
      servingSize: VALID_INPUT.servingSize,
      ingredients: VALID_INPUT.ingredients,
    });
  });

  it('translates a Prisma P2002 unique-violation race into ProductPendingByAnotherUserError', async () => {
    mockTxPackagedFindUnique.mockResolvedValue(null);
    mockTxProductCreate.mockImplementation(() => {
      throw new FakePrismaKnownRequestError('Unique constraint failed', {
        code: 'P2002',
      });
    });

    await expect(
      createSubmittedProduct(VALID_INPUT, 'user-1'),
    ).rejects.toBeInstanceOf(ProductPendingByAnotherUserError);
  });

  it('re-throws unexpected Prisma errors (not P2002) without wrapping', async () => {
    mockTxPackagedFindUnique.mockResolvedValue(null);
    const unexpected = new FakePrismaKnownRequestError('Some other failure', {
      code: 'P2003',
    });
    mockTxProductCreate.mockImplementation(() => {
      throw unexpected;
    });

    await expect(
      createSubmittedProduct(VALID_INPUT, 'user-1'),
    ).rejects.toBe(unexpected);
  });

  it('re-throws unrelated errors (e.g. connection failures) without wrapping', async () => {
    const boom = new Error('DB connection lost');
    mockTxPackagedFindUnique.mockImplementation(() => {
      throw boom;
    });

    await expect(
      createSubmittedProduct(VALID_INPUT, 'user-1'),
    ).rejects.toBe(boom);
  });
});
