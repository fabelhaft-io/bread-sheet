import {
  CUSTOM_PRODUCT_NAME_MAX_RAW_CHARS,
  DUPLICATE_SIMILARITY_THRESHOLD,
  canOfferCreate,
  findLikelyDuplicate,
  isDuplicateNameConflict,
  validateCustomProductName,
} from './custom';
import type { ProductSearchResult } from '@/features/search/api';
import { ApiError } from '@/lib/api';

// Manual mock (lib/__mocks__/api.ts) keeps ApiError as a real class — needed
// so `isDuplicateNameConflict`'s `instanceof` check matches instances
// constructed in this file, without pulling in the real module's Supabase
// client (which throws at import time without env vars).
jest.mock('@/lib/api');

function result(id: string, similarity: number): ProductSearchResult {
  return {
    id,
    kind: 'CUSTOM',
    name: `Item ${id}`,
    brand: null,
    image: null,
    unverified: false,
    similarity,
  };
}

describe('validateCustomProductName', () => {
  it('accepts a trimmed 1-80 char name', () => {
    expect(validateCustomProductName('Negroni')).toEqual({ valid: true, name: 'Negroni' });
    expect(validateCustomProductName('  Negroni  ')).toEqual({ valid: true, name: 'Negroni' });
  });

  it('rejects an empty or whitespace-only name', () => {
    expect(validateCustomProductName('')).toMatchObject({ valid: false, reason: 'empty' });
    expect(validateCustomProductName('   ')).toMatchObject({ valid: false, reason: 'empty' });
  });

  it('rejects a name over the raw character cap, measured before trimming', () => {
    const tooLong = 'a'.repeat(CUSTOM_PRODUCT_NAME_MAX_RAW_CHARS + 1);
    expect(validateCustomProductName(tooLong)).toMatchObject({ valid: false, reason: 'too_long' });
  });

  it('accepts exactly the cap', () => {
    const atCap = 'a'.repeat(CUSTOM_PRODUCT_NAME_MAX_RAW_CHARS);
    expect(validateCustomProductName(atCap)).toMatchObject({ valid: true });
  });
});

describe('canOfferCreate', () => {
  it('requires at least 2 trimmed characters', () => {
    expect(canOfferCreate('')).toBe(false);
    expect(canOfferCreate('n')).toBe(false);
    expect(canOfferCreate(' n ')).toBe(false);
    expect(canOfferCreate('ne')).toBe(true);
  });
});

describe('findLikelyDuplicate', () => {
  it('returns null when there are no results', () => {
    expect(findLikelyDuplicate([])).toBeNull();
  });

  it('returns null when every result is below the threshold', () => {
    const results = [result('a', 0.2), result('b', 0.59)];
    expect(findLikelyDuplicate(results)).toBeNull();
  });

  it('returns the highest-similarity result once it meets the threshold', () => {
    const results = [result('a', 0.4), result('b', DUPLICATE_SIMILARITY_THRESHOLD), result('c', 0.3)];
    expect(findLikelyDuplicate(results)?.id).toBe('b');
  });

  it('picks the best match regardless of list order', () => {
    const results = [result('a', 0.95), result('b', 0.61)];
    expect(findLikelyDuplicate(results)?.id).toBe('a');
  });
});

describe('isDuplicateNameConflict', () => {
  it('recognises the server’s 409 duplicate_name shape', () => {
    const err = new ApiError(409, 'Duplicate', { code: 'duplicate_name', productId: 'p1' });
    expect(isDuplicateNameConflict(err)).toBe(true);
    if (isDuplicateNameConflict(err)) {
      expect(err.body.productId).toBe('p1');
    }
  });

  it('rejects other 409s and other statuses', () => {
    expect(isDuplicateNameConflict(new ApiError(409, 'edit_pending', { error: 'edit_pending' }))).toBe(
      false,
    );
    expect(isDuplicateNameConflict(new ApiError(422, 'nope', { code: 'duplicate_name' }))).toBe(false);
    expect(isDuplicateNameConflict(new Error('boom'))).toBe(false);
  });
});
