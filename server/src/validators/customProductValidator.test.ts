import { describe, it, expect } from 'vitest';
import {
  PackagedFieldNotAllowedError,
  validateCustomProductCorrection,
  validateCustomProductCreate,
  validateCustomProductName,
} from './customProductValidator.js';
import { SubmissionValidationError } from './productSubmissionValidator.js';

const VALID_IMAGE_KEY = 'processed/11111111-1111-4111-8111-111111111111.jpg';
const PRODUCT_ID = '22222222-2222-4222-8222-222222222222';

describe('validateCustomProductName', () => {
  it('trims and returns a valid name', () => {
    expect(validateCustomProductName('  Negroni  ')).toBe('Negroni');
  });

  it('rejects an empty name', () => {
    expect(() => validateCustomProductName('')).toThrow(SubmissionValidationError);
  });

  it('rejects a name that is only whitespace', () => {
    expect(() => validateCustomProductName('   ')).toThrow(SubmissionValidationError);
  });

  it('rejects a non-string value', () => {
    expect(() => validateCustomProductName(42)).toThrow(SubmissionValidationError);
  });

  it('accepts exactly 80 raw characters', () => {
    expect(() => validateCustomProductName('a'.repeat(80))).not.toThrow();
  });

  it('rejects 81 raw characters', () => {
    expect(() => validateCustomProductName('a'.repeat(81))).toThrow(SubmissionValidationError);
  });

  it('measures the 80-char cap on the RAW string, before trimming — padding does not rescue an over-long name', () => {
    // 90 chars of padding around a 4-char real name: trimmed length is fine,
    // but the raw length must still be rejected.
    const padded = ' '.repeat(43) + 'Name' + ' '.repeat(43);
    expect(padded.length).toBeGreaterThan(80);
    expect(() => validateCustomProductName(padded)).toThrow(SubmissionValidationError);
  });
});

describe('validateCustomProductCreate', () => {
  it('accepts { name } with no imageKey', () => {
    expect(validateCustomProductCreate({ name: 'Negroni' })).toEqual({
      name: 'Negroni',
      imageKey: null,
    });
  });

  it('accepts { name, imageKey }', () => {
    expect(validateCustomProductCreate({ name: 'Negroni', imageKey: VALID_IMAGE_KEY })).toEqual({
      name: 'Negroni',
      imageKey: VALID_IMAGE_KEY,
    });
  });

  it('rejects a malformed imageKey', () => {
    expect(() =>
      validateCustomProductCreate({ name: 'Negroni', imageKey: 'not-a-key' }),
    ).toThrow(SubmissionValidationError);
  });

  it('rejects an unknown body shape (not an object)', () => {
    expect(() => validateCustomProductCreate(null)).toThrow(SubmissionValidationError);
  });

  // TICKET-P6-007: a strict allowlist — any packaged-only field (or brand,
  // which custom products never have) is a 400, not a silently-dropped key.
  for (const field of [
    'gtin',
    'barcode',
    'brand',
    'genericName',
    'energyKcal',
    'carbohydrates',
    'sugars',
    'fat',
    'saturatedFat',
    'protein',
    'salt',
    'servingSize',
    'ingredients',
    'allergens',
  ]) {
    it(`rejects a packaged-only field (${field}) with PackagedFieldNotAllowedError`, () => {
      expect(() =>
        validateCustomProductCreate({ name: 'Negroni', [field]: 'anything' }),
      ).toThrow(PackagedFieldNotAllowedError);
    });
  }
});

describe('validateCustomProductCorrection', () => {
  it('accepts a rename-only body', () => {
    expect(
      validateCustomProductCorrection({ productId: PRODUCT_ID, name: 'New Name' }),
    ).toEqual({ productId: PRODUCT_ID, name: 'New Name', imageKey: null });
  });

  it('accepts a photo-only body (productImageKey, not imageKey)', () => {
    expect(
      validateCustomProductCorrection({
        productId: PRODUCT_ID,
        productImageKey: VALID_IMAGE_KEY,
      }),
    ).toEqual({ productId: PRODUCT_ID, name: null, imageKey: VALID_IMAGE_KEY });
  });

  it('rejects an invalid productId', () => {
    expect(() =>
      validateCustomProductCorrection({ productId: 'not-a-uuid', name: 'New Name' }),
    ).toThrow(SubmissionValidationError);
  });

  it('rejects a body with no editable fields', () => {
    expect(() => validateCustomProductCorrection({ productId: PRODUCT_ID })).toThrow(
      SubmissionValidationError,
    );
  });

  it('rejects a packaged-only field with PackagedFieldNotAllowedError', () => {
    expect(() =>
      validateCustomProductCorrection({
        productId: PRODUCT_ID,
        name: 'New Name',
        energyKcal: 120,
      }),
    ).toThrow(PackagedFieldNotAllowedError);
  });

  it('rejects brand', () => {
    expect(() =>
      validateCustomProductCorrection({ productId: PRODUCT_ID, brand: 'Some Brand' }),
    ).toThrow(PackagedFieldNotAllowedError);
  });
});
