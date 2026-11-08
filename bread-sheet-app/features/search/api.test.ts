import { isSearchableQuery, SEARCH_QUERY_MAX_RAW_CHARS, searchProducts } from './api';

jest.mock('@/lib/api', () => ({
  api: { get: jest.fn() },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { api } = require('@/lib/api');
const mockGet = api.get as jest.Mock;

describe('isSearchableQuery', () => {
  it('requires at least 2 trimmed characters', () => {
    expect(isSearchableQuery('')).toBe(false);
    expect(isSearchableQuery(' ')).toBe(false);
    expect(isSearchableQuery('a')).toBe(false);
    expect(isSearchableQuery(' a ')).toBe(false);
    expect(isSearchableQuery('ab')).toBe(true);
  });

  it('caps the RAW length at 100, measured before trimming', () => {
    const raw = `  ${'a'.repeat(99)}`; // 101 raw chars, 99 trimmed
    expect(raw.length).toBe(101);
    expect(isSearchableQuery(raw)).toBe(false);

    const ok = 'a'.repeat(SEARCH_QUERY_MAX_RAW_CHARS);
    expect(isSearchableQuery(ok)).toBe(true);
  });
});

describe('searchProducts', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls GET /api/products/search with the trimmed query', async () => {
    mockGet.mockResolvedValue({ results: [], nextCursor: null });
    await searchProducts('  cola  ', null);
    expect(mockGet).toHaveBeenCalledWith('/api/products/search?q=cola', { signal: undefined });
  });

  it('includes the cursor when paginating', async () => {
    mockGet.mockResolvedValue({ results: [], nextCursor: null });
    await searchProducts('cola', 'cursor-123');
    expect(mockGet).toHaveBeenCalledWith(
      '/api/products/search?q=cola&cursor=cursor-123',
      { signal: undefined },
    );
  });

  it('passes an AbortSignal through so a caller can cancel the request', async () => {
    mockGet.mockResolvedValue({ results: [], nextCursor: null });
    const controller = new AbortController();
    await searchProducts('cola', null, controller.signal);
    expect(mockGet).toHaveBeenCalledWith('/api/products/search?q=cola', {
      signal: controller.signal,
    });
  });
});
