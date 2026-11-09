import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockProductCreate = vi.hoisted(() => vi.fn());
const mockProductFindFirst = vi.hoisted(() => vi.fn());

vi.mock('../db.js', () => ({
  default: {
    product: {
      create: mockProductCreate,
      findFirst: mockProductFindFirst,
    },
  },
}));

// Minimal stand-in for `Prisma.PrismaClientKnownRequestError` so the service
// can `instanceof`-check a simulated unique violation (same pattern used
// throughout this codebase — see productService.test.ts / productController.test.ts).
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
  createCustomProduct,
  DuplicateCustomProductNameError,
  findCustomProductNameCollision,
} from './customProductService.js';
import { ProductKind, ProductStatus } from '../generated/prisma_client/enums.js';

const USER_ID = 'user-1';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createCustomProduct', () => {
  it('creates a CUSTOM product PENDING_REVIEW with no brand, keyed by normalised name', async () => {
    mockProductCreate.mockResolvedValue({
      id: 'product-1',
      status: ProductStatus.PENDING_REVIEW,
    });

    const result = await createCustomProduct(
      { name: 'Négroni ', imageKey: 'processed/abc.jpg' },
      USER_ID,
    );

    expect(result).toEqual({ id: 'product-1', status: ProductStatus.PENDING_REVIEW });
    expect(mockProductCreate).toHaveBeenCalledWith({
      data: {
        kind: ProductKind.CUSTOM,
        name: 'Négroni ',
        brand: null,
        image: 'processed/abc.jpg',
        status: ProductStatus.PENDING_REVIEW,
        submittedByUserId: USER_ID,
        nameKey: 'negroni',
      },
    });
  });

  it('allows imageKey: null (no photo at creation time)', async () => {
    mockProductCreate.mockResolvedValue({ id: 'product-1', status: ProductStatus.PENDING_REVIEW });
    await createCustomProduct({ name: 'Negroni', imageKey: null }, USER_ID);
    expect(mockProductCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ image: null }) }),
    );
  });

  it('maps a P2002 unique-violation to DuplicateCustomProductNameError carrying the existing productId', async () => {
    mockProductCreate.mockRejectedValue(
      new FakePrismaKnownRequestError('unique violation', { code: 'P2002' }),
    );
    mockProductFindFirst.mockResolvedValue({ id: 'existing-product' });

    let caught: unknown;
    try {
      await createCustomProduct({ name: 'Negroni', imageKey: null }, USER_ID);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DuplicateCustomProductNameError);
    expect((caught as DuplicateCustomProductNameError).productId).toBe('existing-product');
    expect((caught as DuplicateCustomProductNameError).code).toBe('duplicate_name');
  });

  it('re-throws an unexpected Prisma error unchanged (not P2002)', async () => {
    const boom = new FakePrismaKnownRequestError('deadlock', { code: 'P2034' });
    mockProductCreate.mockRejectedValue(boom);
    await expect(createCustomProduct({ name: 'Negroni', imageKey: null }, USER_ID)).rejects.toBe(
      boom,
    );
    expect(mockProductFindFirst).not.toHaveBeenCalled();
  });

  // Concurrency: two simultaneous creates of the same (normalised) name must
  // produce exactly one row and one 409. True simultaneity is a DB-level
  // guarantee enforced by the hand-written partial unique index
  // (`custom_product_name_unique`); what this test proves is the
  // application-level race handling that turns the loser's P2002 into a
  // friendly duplicate_name error pointing at the winner's row — the same
  // pattern already used for the GTIN create race in productController.test.ts.
  it('two concurrent creates of the same name produce exactly one created row and one duplicate_name error', async () => {
    const winner = { id: 'winner-product', status: ProductStatus.PENDING_REVIEW };

    let callCount = 0;
    mockProductCreate.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) return winner;
      throw new FakePrismaKnownRequestError('unique violation', { code: 'P2002' });
    });
    mockProductFindFirst.mockResolvedValue({ id: winner.id });

    const [a, b] = await Promise.allSettled([
      createCustomProduct({ name: 'Negroni', imageKey: null }, 'user-a'),
      createCustomProduct({ name: 'negroni', imageKey: null }, 'user-b'),
    ]);

    const results = [a, b];
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(mockProductCreate).toHaveBeenCalledTimes(2);
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((fulfilled[0] as PromiseFulfilledResult<unknown>).value).toEqual({
      id: winner.id,
      status: winner.status,
    });
    const err = (rejected[0] as PromiseRejectedResult).reason as DuplicateCustomProductNameError;
    expect(err).toBeInstanceOf(DuplicateCustomProductNameError);
    expect(err.productId).toBe(winner.id);
    expect(err.code).toBe('duplicate_name');
  });

  it('a REJECTED custom product does not block its name from being reused', async () => {
    // The hand-written partial unique index is scoped to
    // `status <> 'REJECTED'`, so a fresh insert for a previously-rejected
    // name simply succeeds — no P2002, no collision lookup.
    mockProductCreate.mockResolvedValue({ id: 'new-product', status: ProductStatus.PENDING_REVIEW });

    const result = await createCustomProduct({ name: 'Bad Attempt', imageKey: null }, USER_ID);

    expect(result).toEqual({ id: 'new-product', status: ProductStatus.PENDING_REVIEW });
    expect(mockProductFindFirst).not.toHaveBeenCalled();
  });
});

describe('findCustomProductNameCollision', () => {
  it('queries for a non-REJECTED CUSTOM product with the given nameKey', async () => {
    mockProductFindFirst.mockResolvedValue({ id: 'match' });
    const result = await findCustomProductNameCollision({ product: { findFirst: mockProductFindFirst } }, 'negroni');
    expect(result).toEqual({ id: 'match' });
    expect(mockProductFindFirst).toHaveBeenCalledWith({
      where: {
        nameKey: 'negroni',
        kind: ProductKind.CUSTOM,
        status: { not: ProductStatus.REJECTED },
      },
      select: { id: true },
    });
  });

  it('excludes the given id (self-exclusion for a rename check)', async () => {
    mockProductFindFirst.mockResolvedValue(null);
    await findCustomProductNameCollision(
      { product: { findFirst: mockProductFindFirst } },
      'negroni',
      'self-id',
    );
    expect(mockProductFindFirst).toHaveBeenCalledWith({
      where: {
        nameKey: 'negroni',
        kind: ProductKind.CUSTOM,
        status: { not: ProductStatus.REJECTED },
        id: { not: 'self-id' },
      },
      select: { id: true },
    });
  });
});
