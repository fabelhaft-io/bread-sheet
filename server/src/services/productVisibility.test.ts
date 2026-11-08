import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockProductFindFirst = vi.hoisted(() => vi.fn());

vi.mock('../db.js', () => ({
  default: { product: { findFirst: mockProductFindFirst } },
}));

import {
  assertProductVisible,
  visibleProductWhere,
  ProductNotFoundError,
  INVISIBLE_PRODUCT_STATUS,
} from './productVisibility.js';
import { ProductStatus } from '../generated/prisma_client/enums.js';

describe('visibleProductWhere', () => {
  it('excludes REJECTED products, and only REJECTED products', () => {
    expect(visibleProductWhere()).toEqual({ status: { not: ProductStatus.REJECTED } });
  });

  it('is built from the single shared INVISIBLE_PRODUCT_STATUS constant (TICKET-P6-008)', () => {
    // productSearchService's raw-SQL query excludes the same constant instead
    // of re-typing `REJECTED` — pin the value so the two callers can't drift.
    expect(INVISIBLE_PRODUCT_STATUS).toBe(ProductStatus.REJECTED);
    expect(visibleProductWhere()).toEqual({ status: { not: INVISIBLE_PRODUCT_STATUS } });
  });

  it('is the same for an anonymous caller — the rule does not vary by caller', () => {
    expect(visibleProductWhere({ isAnonymous: true })).toEqual(
      visibleProductWhere({ isAnonymous: false }),
    );
  });
});

describe('assertProductVisible', () => {
  beforeEach(() => {
    mockProductFindFirst.mockReset();
  });

  it('resolves when the product is visible', async () => {
    mockProductFindFirst.mockResolvedValue({ id: 'p1' });
    await expect(assertProductVisible(undefined, 'p1')).resolves.toBeUndefined();
    expect(mockProductFindFirst).toHaveBeenCalledWith({
      where: { id: 'p1', status: { not: ProductStatus.REJECTED } },
      select: { id: true },
    });
  });

  it('throws ProductNotFoundError when the product does not exist', async () => {
    mockProductFindFirst.mockResolvedValue(null);
    await expect(assertProductVisible(undefined, 'missing')).rejects.toBeInstanceOf(
      ProductNotFoundError,
    );
  });

  it('throws ProductNotFoundError for a REJECTED product (filtered out of the query)', async () => {
    mockProductFindFirst.mockResolvedValue(null);
    await expect(assertProductVisible(undefined, 'rejected-1')).rejects.toBeInstanceOf(
      ProductNotFoundError,
    );
  });
});
