import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./imageService.js', () => ({
  resolveImageUrl: (v: string | null) => (v ? `http://assets.test/${v}` : v),
}));

import { serializeProduct, type SerializableProduct } from './productSerializer.js';
import { ProductKind, ProductStatus } from '../generated/prisma_client/enums.js';

const PACKAGED = {
  gtin: '1234567890123',
  genericName: 'Bread',
  energyKcal: 250,
  fat: 3,
  saturatedFat: 1,
  carbohydrates: 45,
  sugars: 4,
  protein: 8,
  salt: 1.2,
  servingSize: '50g',
  ingredients: 'flour, water',
};

const VERIFIED_PACKAGED: SerializableProduct = {
  id: 'p1',
  kind: ProductKind.PACKAGED,
  name: 'Sourdough',
  brand: 'BakeryCo',
  image: 'processed/abc.jpg',
  description: null,
  status: ProductStatus.VERIFIED,
  submittedByUserId: 'user-1',
  packaged: PACKAGED,
};

describe('serializeProduct', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves the image and marks a VERIFIED product unverified: false', () => {
    const result = serializeProduct(VERIFIED_PACKAGED, { isAnonymous: false });
    expect(result.unverified).toBe(false);
    expect(result.image).toBe('http://assets.test/processed/abc.jpg');
    expect(result.submission).toBeUndefined();
  });

  it('nests packaged fields under `packaged`, not at the top level', () => {
    const result = serializeProduct(VERIFIED_PACKAGED, { isAnonymous: false });
    expect(result.packaged).toEqual(PACKAGED);
    expect(result).not.toHaveProperty('gtin');
    expect(result).not.toHaveProperty('energyKcal');
  });

  it('returns packaged: null for a CUSTOM product, with no submission nutrition block', () => {
    const custom: SerializableProduct = {
      ...VERIFIED_PACKAGED,
      kind: ProductKind.CUSTOM,
      status: ProductStatus.PENDING_REVIEW,
      packaged: null,
    };
    const result = serializeProduct(custom, { isAnonymous: false });
    expect(result.packaged).toBeNull();
    expect(result.submission).toEqual({ name: custom.name, brand: custom.brand });
  });

  it('includes submittedByUserId for a registered caller', () => {
    const result = serializeProduct(VERIFIED_PACKAGED, { isAnonymous: false });
    expect(result.submittedByUserId).toBe('user-1');
  });

  it('omits submittedByUserId for an anonymous caller', () => {
    const result = serializeProduct(VERIFIED_PACKAGED, { isAnonymous: true });
    expect(result).not.toHaveProperty('submittedByUserId');
  });

  it('includes submittedByUserId when no caller is given (only `isAnonymous: true` hides it)', () => {
    const result = serializeProduct(VERIFIED_PACKAGED);
    expect(result.submittedByUserId).toBe('user-1');
  });

  it('adds a flat submission block (name/brand + packaged fields) for an unverified product', () => {
    const pending: SerializableProduct = {
      ...VERIFIED_PACKAGED,
      status: ProductStatus.PENDING_REVIEW,
    };
    const result = serializeProduct(pending, { isAnonymous: false });
    expect(result.unverified).toBe(true);
    expect(result.submission).toEqual({
      name: pending.name,
      brand: pending.brand,
      genericName: PACKAGED.genericName,
      energyKcal: PACKAGED.energyKcal,
      fat: PACKAGED.fat,
      saturatedFat: PACKAGED.saturatedFat,
      carbohydrates: PACKAGED.carbohydrates,
      sugars: PACKAGED.sugars,
      protein: PACKAGED.protein,
      salt: PACKAGED.salt,
      servingSize: PACKAGED.servingSize,
      ingredients: PACKAGED.ingredients,
    });
  });

  it('never leaks a field outside the explicit allowlist', () => {
    const withExtras = {
      ...VERIFIED_PACKAGED,
      // Simulate an internal column a future ticket adds (e.g. P6-007's
      // nameKey, P6-005's OFF-sync state) reaching the serializer by
      // accident — it must never appear on the response.
      nameKey: 'sourdough',
      offSyncStatus: 'PENDING',
    } as unknown as SerializableProduct;

    const result = serializeProduct(withExtras, { isAnonymous: false });
    expect(Object.keys(result).sort()).toEqual(
      ['brand', 'description', 'id', 'image', 'kind', 'name', 'packaged', 'status', 'submittedByUserId', 'unverified'].sort(),
    );
    expect(result.packaged && Object.keys(result.packaged).sort()).toEqual(
      ['carbohydrates', 'energyKcal', 'fat', 'genericName', 'gtin', 'ingredients', 'protein', 'salt', 'saturatedFat', 'servingSize', 'sugars'].sort(),
    );
  });
});
