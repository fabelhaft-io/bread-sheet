import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQueryRaw = vi.hoisted(() => vi.fn());

vi.mock('../db.js', () => ({
  default: { $queryRaw: mockQueryRaw },
}));

import {
  parseSearchQuery,
  encodeSearchCursor,
  decodeSearchCursor,
  searchProducts,
  SearchValidationError,
  SEARCH_PAGE_SIZE,
} from './productSearchService.js';
import { ProductKind, ProductStatus } from '../generated/prisma_client/enums.js';
import { INVISIBLE_PRODUCT_STATUS } from './productVisibility.js';
import { Prisma } from '../generated/prisma_client/client.js';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: UUID_A,
    kind: ProductKind.PACKAGED,
    name: 'Nutella',
    brand: 'Ferrero',
    image: null,
    status: ProductStatus.VERIFIED,
    similarity: 0.6666667,
    ratingCount: 3,
    ...overrides,
  };
}

/**
 * Pulls the mocked `$queryRaw` tagged-template call apart into flattened SQL
 * text and bound values. A bare mock (unlike the real `$queryRaw`) does not
 * itself flatten a nested `Prisma.sql` fragment — the service interpolates
 * `cursorCondition` (itself built with `Prisma.sql`) into the outer
 * template, so the captured call is `(strings, ..., cursorConditionOrEmpty,
 * ...)`. `Prisma.sql` performs the exact same flattening whether invoked as
 * a tag or as a plain function with the same arguments (verified against the
 * real runtime), so re-running the captured arguments through it reproduces
 * what the real driver would actually send.
 */
function lastQueryRawCall(): { text: string; values: unknown[] } {
  const call = mockQueryRaw.mock.calls[mockQueryRaw.mock.calls.length - 1];
  const [strings, ...values] = call as [readonly string[], ...unknown[]];
  const flattened = (Prisma.sql as unknown as (s: readonly string[], ...v: unknown[]) => Prisma.Sql)(
    strings,
    ...values,
  );
  return { text: flattened.strings.join('␟'), values: flattened.values };
}

describe('parseSearchQuery', () => {
  it('trims and accepts a valid query', () => {
    expect(parseSearchQuery('  nutela  ')).toBe('nutela');
  });

  it('rejects a non-string value', () => {
    expect(() => parseSearchQuery(undefined)).toThrow(SearchValidationError);
    expect(() => parseSearchQuery(['nutela'])).toThrow(SearchValidationError);
  });

  it('rejects an empty string', () => {
    try {
      parseSearchQuery('');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SearchValidationError);
      expect((err as SearchValidationError).code).toBe('query_required');
    }
  });

  it('rejects more than 100 raw characters, measured BEFORE trimming', () => {
    // 99 spaces + 2 real chars = 101 raw chars, 2 trimmed chars — would pass a
    // trim-first check and must still be rejected (CLAUDE.md regex/input
    // hygiene convention: measure the raw string, not .trim().length).
    const padded = ' '.repeat(99) + 'ab';
    expect(padded.length).toBe(101);
    try {
      parseSearchQuery(padded);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SearchValidationError);
      expect((err as SearchValidationError).code).toBe('query_too_long');
    }
  });

  it('accepts exactly 100 raw characters', () => {
    expect(() => parseSearchQuery('a'.repeat(100))).not.toThrow();
  });

  it('rejects fewer than 2 trimmed characters', () => {
    try {
      parseSearchQuery('  a  ');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SearchValidationError);
      expect((err as SearchValidationError).code).toBe('query_too_short');
    }
  });

  it('accepts exactly 2 trimmed characters', () => {
    expect(parseSearchQuery(' ab ')).toBe('ab');
  });
});

describe('encodeSearchCursor / decodeSearchCursor', () => {
  it('round-trips a valid cursor for the same query', () => {
    const cursor = { q: 'nutela', s: 0.667, r: 3, id: UUID_A };
    const encoded = encodeSearchCursor(cursor);
    expect(decodeSearchCursor(encoded, 'nutela')).toEqual(cursor);
  });

  it('returns undefined for no cursor (first page)', () => {
    expect(decodeSearchCursor(undefined, 'nutela')).toBeUndefined();
    expect(decodeSearchCursor(null, 'nutela')).toBeUndefined();
    expect(decodeSearchCursor('', 'nutela')).toBeUndefined();
  });

  it('rejects a cursor that is not a string', () => {
    expect(() => decodeSearchCursor(['x'], 'nutela')).toThrow(SearchValidationError);
  });

  it('rejects a cursor that does not base64url-decode to JSON', () => {
    expect(() => decodeSearchCursor('not-valid-base64url!!', 'nutela')).toThrow(
      SearchValidationError,
    );
  });

  it('rejects a cursor missing required fields', () => {
    const bad = Buffer.from(JSON.stringify({ q: 'nutela' }), 'utf8').toString('base64url');
    expect(() => decodeSearchCursor(bad, 'nutela')).toThrow(SearchValidationError);
  });

  it('rejects a cursor with the wrong field types', () => {
    const bad = Buffer.from(
      JSON.stringify({ q: 'nutela', s: 'not-a-number', r: 3, id: UUID_A }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeSearchCursor(bad, 'nutela')).toThrow(SearchValidationError);
  });

  it('rejects a cursor whose id is not a UUID', () => {
    const bad = Buffer.from(
      JSON.stringify({ q: 'nutela', s: 0.5, r: 1, id: 'not-a-uuid' }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeSearchCursor(bad, 'nutela')).toThrow(SearchValidationError);
  });

  it('rejects a cursor issued for a different query', () => {
    const cursor = encodeSearchCursor({ q: 'nutela', s: 0.5, r: 1, id: UUID_A });
    expect(() => decodeSearchCursor(cursor, 'negroni')).toThrow(SearchValidationError);
  });

  it('rejects an oversized cursor string', () => {
    const huge = 'a'.repeat(3000);
    expect(() => decodeSearchCursor(huge, 'nutela')).toThrow(SearchValidationError);
  });
});

describe('searchProducts', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
  });

  it('excludes REJECTED via the single shared productVisibility constant, bound as a parameter (not spliced into SQL text)', async () => {
    mockQueryRaw.mockResolvedValue([]);

    await searchProducts(undefined, 'nutela', undefined);

    const { text, values } = lastQueryRawCall();
    expect(INVISIBLE_PRODUCT_STATUS).toBe('REJECTED');
    // The exclusion value is a bound parameter...
    expect(values).toContain(INVISIBLE_PRODUCT_STATUS);
    // ...never literal text in the query itself.
    expect(text).not.toMatch(/REJECTED/);
    expect(text).toMatch(/p\.status <>/);
  });

  it('never splices the raw query string into the SQL text, however hostile', async () => {
    mockQueryRaw.mockResolvedValue([]);
    const hostile = "x'); DROP TABLE \"Product\"; --";

    await searchProducts(undefined, hostile, undefined);

    const { text, values } = lastQueryRawCall();
    expect(text).not.toContain('DROP TABLE');
    expect(values).toContain(hostile);
  });

  it('maps rows into the API contract shape, resolving images and flagging unverified', async () => {
    mockQueryRaw.mockResolvedValue([
      makeRow({ status: ProductStatus.VERIFIED, image: 'processed/abc.jpg' }),
      makeRow({
        id: UUID_B,
        kind: ProductKind.CUSTOM,
        name: 'Negroni',
        brand: null,
        status: ProductStatus.PENDING_REVIEW,
        similarity: 0.5,
        ratingCount: 0,
      }),
    ]);

    const result = await searchProducts(undefined, 'nutela', undefined);

    expect(result.results).toEqual([
      {
        id: UUID_A,
        kind: ProductKind.PACKAGED,
        name: 'Nutella',
        brand: 'Ferrero',
        image: expect.stringContaining('processed/abc.jpg'),
        unverified: false,
        similarity: 0.6666667,
      },
      {
        id: UUID_B,
        kind: ProductKind.CUSTOM,
        name: 'Negroni',
        brand: null,
        image: null,
        unverified: true,
        similarity: 0.5,
      },
    ]);
    expect(result.nextCursor).toBeNull();
  });

  it('sets nextCursor from the last row when more than a page of rows comes back, and trims to the page size', async () => {
    const rows = Array.from({ length: SEARCH_PAGE_SIZE + 1 }, (_, i) =>
      makeRow({ id: `11111111-1111-4111-8111-11111111${String(i).padStart(4, '0')}` }),
    );
    mockQueryRaw.mockResolvedValue(rows);

    const result = await searchProducts(undefined, 'nutela', undefined);

    expect(result.results).toHaveLength(SEARCH_PAGE_SIZE);
    expect(result.nextCursor).not.toBeNull();

    const decoded = decodeSearchCursor(result.nextCursor!, 'nutela');
    const lastIncludedRow = rows[SEARCH_PAGE_SIZE - 1]!;
    expect(decoded).toEqual({
      q: 'nutela',
      s: lastIncludedRow.similarity,
      r: lastIncludedRow.ratingCount,
      id: lastIncludedRow.id,
    });
  });

  it('returns nextCursor: null when exactly a page of rows comes back (no more pages)', async () => {
    const rows = Array.from({ length: SEARCH_PAGE_SIZE }, (_, i) =>
      makeRow({ id: `11111111-1111-4111-8111-11111111${String(i).padStart(4, '0')}` }),
    );
    mockQueryRaw.mockResolvedValue(rows);

    const result = await searchProducts(undefined, 'nutela', undefined);

    expect(result.results).toHaveLength(SEARCH_PAGE_SIZE);
    expect(result.nextCursor).toBeNull();
  });

  it('applies the cursor keyset predicate as bound parameters when a cursor is supplied', async () => {
    mockQueryRaw.mockResolvedValue([]);
    const cursor = encodeSearchCursor({ q: 'nutela', s: 0.5, r: 2, id: UUID_A });

    await searchProducts(undefined, 'nutela', cursor);

    const { text, values } = lastQueryRawCall();
    expect(text).toMatch(/ratingCount/);
    expect(values).toContain(0.5);
    expect(values).toContain(2);
    expect(values).toContain(UUID_A);
  });

  it('propagates query validation errors without calling the database', async () => {
    await expect(searchProducts(undefined, 'a', undefined)).rejects.toBeInstanceOf(
      SearchValidationError,
    );
    expect(mockQueryRaw).not.toHaveBeenCalled();
  });

  it('propagates cursor validation errors without calling the database', async () => {
    await expect(
      searchProducts(undefined, 'nutela', 'not-a-valid-cursor!!'),
    ).rejects.toBeInstanceOf(SearchValidationError);
    expect(mockQueryRaw).not.toHaveBeenCalled();
  });
});
