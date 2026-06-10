import { describe, it, expect } from 'vitest';
import {
  SubmissionValidationError,
  validateProductSubmission,
} from './productSubmissionValidator.js';

const VALID_PAYLOAD = {
  barcode: '1234567890123',
  name: 'Sourdough Bread',
  brand: 'BakeryCo',
  genericName: 'Bread',
  energyKcal: 250,
  carbohydrates: 45,
  sugars: 3.0,
  fat: 3.5,
  saturatedFat: 1.2,
  protein: 8,
  salt: 1.2,
  servingSize: '50g',
  productImageKey: 'processed/123e4567-e89b-42d3-a456-426614174000.jpg',
  ingredients: 'Flour, water, salt, yeast',
};

describe('validateProductSubmission', () => {
  describe('happy path', () => {
    it('returns the normalised payload when all fields are valid', () => {
      const result = validateProductSubmission(VALID_PAYLOAD);
      expect(result).toEqual(VALID_PAYLOAD);
    });

    it('trims whitespace from string fields', () => {
      const result = validateProductSubmission({
        ...VALID_PAYLOAD,
        name: '  Sourdough Bread  ',
        brand: '  BakeryCo  ',
      });
      expect(result.name).toBe('Sourdough Bread');
      expect(result.brand).toBe('BakeryCo');
    });

    it('accepts null values for all optional fields', () => {
      const result = validateProductSubmission({
        barcode: '1234567890123',
        name: 'Sourdough',
        brand: null,
        genericName: null,
        energyKcal: null,
        carbohydrates: null,
        sugars: null,
        fat: null,
        saturatedFat: null,
        protein: null,
        salt: null,
        servingSize: null,
        productImageKey: 'processed/123e4567-e89b-42d3-a456-426614174000.jpg',
        ingredients: null,
      });
      expect(result.brand).toBeNull();
      expect(result.energyKcal).toBeNull();
      expect(result.sugars).toBeNull();
      expect(result.saturatedFat).toBeNull();
      expect(result.ingredients).toBeNull();
    });

    it('accepts undefined optional fields and coerces them to null', () => {
      const result = validateProductSubmission({
        barcode: '1234567890123',
        name: 'Sourdough',
        productImageKey: 'processed/123e4567-e89b-42d3-a456-426614174000.jpg',
      });
      expect(result.brand).toBeNull();
      expect(result.energyKcal).toBeNull();
      expect(result.salt).toBeNull();
    });

    it('coerces empty/whitespace-only optional strings to null', () => {
      const result = validateProductSubmission({
        ...VALID_PAYLOAD,
        brand: '   ',
        genericName: '',
      });
      expect(result.brand).toBeNull();
      expect(result.genericName).toBeNull();
    });

    it('accepts numeric boundary values (0)', () => {
      const result = validateProductSubmission({
        ...VALID_PAYLOAD,
        energyKcal: 0,
        carbohydrates: 0,
      });
      expect(result.energyKcal).toBe(0);
      expect(result.carbohydrates).toBe(0);
    });

    it('accepts 8-digit (EAN-8) barcodes', () => {
      const result = validateProductSubmission({
        ...VALID_PAYLOAD,
        barcode: '12345678',
      });
      expect(result.barcode).toBe('12345678');
    });

    it('accepts 14-digit (GTIN-14) barcodes', () => {
      const result = validateProductSubmission({
        ...VALID_PAYLOAD,
        barcode: '12345678901234',
      });
      expect(result.barcode).toBe('12345678901234');
    });
  });

  describe('body shape', () => {
    it('throws when the body is null', () => {
      expect(() => validateProductSubmission(null)).toThrow(
        SubmissionValidationError,
      );
      try {
        validateProductSubmission(null);
      } catch (err) {
        expect((err as SubmissionValidationError).field).toBe('body');
      }
    });

    it('throws when the body is a primitive (string)', () => {
      expect(() => validateProductSubmission('hello')).toThrow(
        SubmissionValidationError,
      );
    });

    it('throws when the body is undefined', () => {
      expect(() => validateProductSubmission(undefined)).toThrow(
        SubmissionValidationError,
      );
    });
  });

  describe('barcode', () => {
    it('throws when barcode is missing', () => {
      const { barcode: _b, ...rest } = VALID_PAYLOAD;
      try {
        validateProductSubmission(rest);
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(SubmissionValidationError);
        expect((err as SubmissionValidationError).field).toBe('barcode');
      }
    });

    it('throws when barcode is not a string', () => {
      try {
        validateProductSubmission({ ...VALID_PAYLOAD, barcode: 1234567890123 });
        throw new Error('expected throw');
      } catch (err) {
        expect((err as SubmissionValidationError).field).toBe('barcode');
      }
    });

    it('throws when barcode is too short (< 8 digits)', () => {
      try {
        validateProductSubmission({ ...VALID_PAYLOAD, barcode: '1234567' });
        throw new Error('expected throw');
      } catch (err) {
        expect((err as SubmissionValidationError).field).toBe('barcode');
        expect((err as Error).message).toMatch(/8.{1,3}14 digits/);
      }
    });

    it('throws when barcode contains non-digits', () => {
      try {
        validateProductSubmission({ ...VALID_PAYLOAD, barcode: 'abc12345' });
        throw new Error('expected throw');
      } catch (err) {
        expect((err as SubmissionValidationError).field).toBe('barcode');
      }
    });

    it('throws when barcode is whitespace only', () => {
      try {
        validateProductSubmission({ ...VALID_PAYLOAD, barcode: '          ' });
        throw new Error('expected throw');
      } catch (err) {
        expect((err as SubmissionValidationError).field).toBe('barcode');
      }
    });
  });

  describe('name', () => {
    it('throws when name is missing', () => {
      const { name: _n, ...rest } = VALID_PAYLOAD;
      try {
        validateProductSubmission(rest);
        throw new Error('expected throw');
      } catch (err) {
        expect((err as SubmissionValidationError).field).toBe('name');
      }
    });

    it('throws when name is an empty string', () => {
      try {
        validateProductSubmission({ ...VALID_PAYLOAD, name: '' });
        throw new Error('expected throw');
      } catch (err) {
        expect((err as SubmissionValidationError).field).toBe('name');
      }
    });

    it('throws when name exceeds 200 chars', () => {
      try {
        validateProductSubmission({ ...VALID_PAYLOAD, name: 'a'.repeat(201) });
        throw new Error('expected throw');
      } catch (err) {
        expect((err as SubmissionValidationError).field).toBe('name');
        expect((err as Error).message).toMatch(/too long/);
      }
    });
  });

  describe('productImageKey', () => {
    it('throws when productImageKey is missing', () => {
      const { productImageKey: _p, ...rest } = VALID_PAYLOAD;
      try {
        validateProductSubmission(rest);
        throw new Error('expected throw');
      } catch (err) {
        expect((err as SubmissionValidationError).field).toBe('productImageKey');
      }
    });

    it('throws when productImageKey is an arbitrary external URL', () => {
      try {
        validateProductSubmission({
          ...VALID_PAYLOAD,
          productImageKey: 'https://attacker.example.com/evil.jpg',
        });
        throw new Error('expected throw');
      } catch (err) {
        expect((err as SubmissionValidationError).field).toBe('productImageKey');
        expect((err as Error).message).toMatch(/server-issued/);
      }
    });

    it('throws when productImageKey is an absolute URL even if it contains /processed/', () => {
      // Pre-key-era clients sent full URLs — those must now be rejected so the
      // image column only ever stores keys (or OFF URLs written server-side).
      try {
        validateProductSubmission({
          ...VALID_PAYLOAD,
          productImageKey:
            'http://localhost:4566/bucket/processed/123e4567-e89b-42d3-a456-426614174000.jpg',
        });
        throw new Error('expected throw');
      } catch (err) {
        expect((err as SubmissionValidationError).field).toBe('productImageKey');
      }
    });

    it('throws when the key is not a UUID-shaped processed/ jpg', () => {
      try {
        validateProductSubmission({
          ...VALID_PAYLOAD,
          productImageKey: 'processed/../raw/product/escape.jpg',
        });
        throw new Error('expected throw');
      } catch (err) {
        expect((err as SubmissionValidationError).field).toBe('productImageKey');
      }
    });
  });

  describe('optional numeric fields', () => {
    it('throws when energyKcal is not a number', () => {
      try {
        validateProductSubmission({
          ...VALID_PAYLOAD,
          energyKcal: '250' as unknown as number,
        });
        throw new Error('expected throw');
      } catch (err) {
        expect((err as SubmissionValidationError).field).toBe('energyKcal');
      }
    });

    it('throws when a numeric field is NaN', () => {
      try {
        validateProductSubmission({ ...VALID_PAYLOAD, protein: NaN });
        throw new Error('expected throw');
      } catch (err) {
        expect((err as SubmissionValidationError).field).toBe('protein');
      }
    });

    it('throws when a numeric field is Infinity', () => {
      try {
        validateProductSubmission({ ...VALID_PAYLOAD, fat: Infinity });
        throw new Error('expected throw');
      } catch (err) {
        expect((err as SubmissionValidationError).field).toBe('fat');
      }
    });

    it('throws when a numeric field is negative', () => {
      try {
        validateProductSubmission({ ...VALID_PAYLOAD, salt: -0.5 });
        throw new Error('expected throw');
      } catch (err) {
        expect((err as SubmissionValidationError).field).toBe('salt');
        expect((err as Error).message).toMatch(/out of range/);
      }
    });

    it('throws when a numeric field is >= 10000', () => {
      try {
        validateProductSubmission({ ...VALID_PAYLOAD, energyKcal: 10000 });
        throw new Error('expected throw');
      } catch (err) {
        expect((err as SubmissionValidationError).field).toBe('energyKcal');
      }
    });
  });

  describe('optional string fields', () => {
    it('throws when an optional string field is not a string', () => {
      try {
        validateProductSubmission({
          ...VALID_PAYLOAD,
          brand: 123 as unknown as string,
        });
        throw new Error('expected throw');
      } catch (err) {
        expect((err as SubmissionValidationError).field).toBe('brand');
        expect((err as Error).message).toMatch(/must be a string/);
      }
    });

    it('throws when servingSize exceeds 100 chars', () => {
      try {
        validateProductSubmission({
          ...VALID_PAYLOAD,
          servingSize: 'x'.repeat(101),
        });
        throw new Error('expected throw');
      } catch (err) {
        expect((err as SubmissionValidationError).field).toBe('servingSize');
      }
    });

    it('throws when ingredients exceeds 2000 chars', () => {
      try {
        validateProductSubmission({
          ...VALID_PAYLOAD,
          ingredients: 'x'.repeat(2001),
        });
        throw new Error('expected throw');
      } catch (err) {
        expect((err as SubmissionValidationError).field).toBe('ingredients');
      }
    });
  });
});