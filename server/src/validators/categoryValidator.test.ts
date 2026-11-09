import { describe, it, expect } from 'vitest';
import {
  CategoryValidationError,
  validateCategoryCreate,
  validateCategoryMerge,
  validateCategoryName,
  validateCategoryRename,
  validateRatingCategoryFields,
} from './categoryValidator.js';

describe('validateCategoryName', () => {
  it('trims whitespace', () => {
    expect(validateCategoryName('  Wine  ')).toBe('Wine');
  });

  it('throws when empty after trimming', () => {
    expect(() => validateCategoryName('   ')).toThrow(CategoryValidationError);
  });

  it('throws when not a string', () => {
    expect(() => validateCategoryName(42)).toThrow(CategoryValidationError);
  });

  it('accepts exactly 24 raw characters', () => {
    expect(validateCategoryName('a'.repeat(24))).toBe('a'.repeat(24));
  });

  it('throws over 24 raw characters, measured before trimming', () => {
    // 24 real chars plus padding — the cap is on the RAW string (CLAUDE.md convention).
    const padded = 'a'.repeat(24) + '    ';
    expect(() => validateCategoryName(padded)).toThrow(CategoryValidationError);
  });
});

describe('validateCategoryCreate', () => {
  it('accepts { name }', () => {
    expect(validateCategoryCreate({ name: 'Wine' })).toEqual({ name: 'Wine' });
  });

  it('accepts { seedSlug }', () => {
    expect(validateCategoryCreate({ seedSlug: 'wine' })).toEqual({ seedSlug: 'wine' });
  });

  it('throws when both name and seedSlug are provided', () => {
    expect(() => validateCategoryCreate({ name: 'Wine', seedSlug: 'wine' })).toThrow(
      CategoryValidationError,
    );
  });

  it('throws when neither is provided', () => {
    expect(() => validateCategoryCreate({})).toThrow(CategoryValidationError);
  });

  it('throws on an unrecognised seedSlug', () => {
    expect(() => validateCategoryCreate({ seedSlug: 'not-a-seed' })).toThrow(
      CategoryValidationError,
    );
  });

  it('throws on an unexpected extra key', () => {
    expect(() => validateCategoryCreate({ name: 'Wine', extra: 'nope' })).toThrow(
      CategoryValidationError,
    );
  });

  it('throws when the body is not an object', () => {
    expect(() => validateCategoryCreate(null)).toThrow(CategoryValidationError);
    expect(() => validateCategoryCreate('wine')).toThrow(CategoryValidationError);
  });
});

describe('validateCategoryRename', () => {
  it('accepts { name }', () => {
    expect(validateCategoryRename({ name: 'Fine Wine' })).toEqual({ name: 'Fine Wine' });
  });

  it('throws on an unexpected key', () => {
    expect(() => validateCategoryRename({ name: 'Wine', slug: 'wine' })).toThrow(
      CategoryValidationError,
    );
  });
});

describe('validateCategoryMerge', () => {
  const VALID_UUID = '11111111-1111-4111-8111-111111111111';

  it('accepts { intoId } when it is a valid UUID', () => {
    expect(validateCategoryMerge({ intoId: VALID_UUID })).toEqual({ intoId: VALID_UUID });
  });

  it('throws when intoId is not a UUID', () => {
    expect(() => validateCategoryMerge({ intoId: 'not-a-uuid' })).toThrow(CategoryValidationError);
  });

  it('throws on an unexpected key', () => {
    expect(() => validateCategoryMerge({ intoId: VALID_UUID, force: true })).toThrow(
      CategoryValidationError,
    );
  });
});

describe('validateRatingCategoryFields', () => {
  const VALID_UUID = '11111111-1111-4111-8111-111111111111';

  it('both omitted → { kind: "unset" }', () => {
    expect(validateRatingCategoryFields({})).toEqual({ kind: 'unset' });
  });

  it('categoryId: null → { kind: "clear" }', () => {
    expect(validateRatingCategoryFields({ categoryId: null })).toEqual({ kind: 'clear' });
  });

  it('categoryId: <uuid> → { kind: "id", categoryId }', () => {
    expect(validateRatingCategoryFields({ categoryId: VALID_UUID })).toEqual({
      kind: 'id',
      categoryId: VALID_UUID,
    });
  });

  it('a non-UUID categoryId throws', () => {
    expect(() => validateRatingCategoryFields({ categoryId: 'not-a-uuid' })).toThrow(
      CategoryValidationError,
    );
  });

  it('seedSlug: <slug> → { kind: "seed", seedSlug }', () => {
    expect(validateRatingCategoryFields({ seedSlug: 'wine' })).toEqual({
      kind: 'seed',
      seedSlug: 'wine',
    });
  });

  it('an unrecognised seedSlug throws', () => {
    expect(() => validateRatingCategoryFields({ seedSlug: 'not-a-seed' })).toThrow(
      CategoryValidationError,
    );
  });

  it('both categoryId and seedSlug throws (ambiguous)', () => {
    expect(() =>
      validateRatingCategoryFields({ categoryId: VALID_UUID, seedSlug: 'wine' }),
    ).toThrow(CategoryValidationError);
  });

  it('categoryId: undefined explicitly is the same as omitted', () => {
    expect(validateRatingCategoryFields({ categoryId: undefined })).toEqual({ kind: 'unset' });
  });
});
