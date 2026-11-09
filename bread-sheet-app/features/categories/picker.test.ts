import type { UserCategory } from './types';
import {
  buildRatingCategoryFields,
  mapSuggestion,
  sortOwnCategories,
  unusedSeeds,
} from './picker';

function category(id: string, name: string, slug: string, ratingCount = 0, isSeed = false): UserCategory {
  return { id, name, slug, isSeed, ratingCount, createdAt: '2026-01-01T00:00:00.000Z' };
}

describe('mapSuggestion', () => {
  it('maps to the existing own category with a matching slug', () => {
    const own = [category('c1', 'Wine', 'wine', 5)];
    expect(mapSuggestion('wine', own)).toEqual({ kind: 'existing', id: 'c1', name: 'Wine' });
  });

  it('offers an unmaterialised seed when there is no existing match', () => {
    expect(mapSuggestion('wine', [])).toEqual({ kind: 'seed', slug: 'wine', name: 'Wine' });
  });

  it('returns null for no suggestion', () => {
    expect(mapSuggestion(null, [])).toBeNull();
    expect(mapSuggestion(undefined, [])).toBeNull();
  });

  it('returns null for an unknown slug that is neither an own category nor a seed', () => {
    expect(mapSuggestion('not-a-real-slug', [])).toBeNull();
  });

  it('prefers the existing match over the seed even if both exist', () => {
    const own = [category('c1', 'My Wines', 'wine', 2)];
    expect(mapSuggestion('wine', own)).toEqual({ kind: 'existing', id: 'c1', name: 'My Wines' });
  });
});

describe('sortOwnCategories', () => {
  it('orders most-used first', () => {
    const own = [category('a', 'Beer', 'beer', 1), category('b', 'Wine', 'wine', 9)];
    expect(sortOwnCategories(own).map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('breaks ties alphabetically for a stable order', () => {
    const own = [category('a', 'Zebra', 'zebra', 3), category('b', 'Apple', 'apple', 3)];
    expect(sortOwnCategories(own).map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('does not mutate the input', () => {
    const own = [category('a', 'Beer', 'beer', 1), category('b', 'Wine', 'wine', 9)];
    const copy = [...own];
    sortOwnCategories(own);
    expect(own).toEqual(copy);
  });
});

describe('unusedSeeds', () => {
  it('excludes seeds the user has already materialised', () => {
    const own = [category('c1', 'Wine', 'wine', 1)];
    const seeds = unusedSeeds(own);
    expect(seeds.some((s) => s.slug === 'wine')).toBe(false);
    expect(seeds.some((s) => s.slug === 'beer')).toBe(true);
  });

  it('returns every seed when the user has no own categories', () => {
    expect(unusedSeeds([])).toHaveLength(23);
  });
});

describe('buildRatingCategoryFields', () => {
  it('sends nothing when the user never touched category', () => {
    expect(buildRatingCategoryFields(null, false)).toEqual({});
    expect(buildRatingCategoryFields({ kind: 'existing', id: 'c1', name: 'Wine' }, false)).toEqual({});
  });

  it('sends categoryId for an existing selection', () => {
    expect(buildRatingCategoryFields({ kind: 'existing', id: 'c1', name: 'Wine' }, true)).toEqual({
      categoryId: 'c1',
    });
  });

  it('sends seedSlug for an unmaterialised seed selection', () => {
    expect(buildRatingCategoryFields({ kind: 'seed', slug: 'wine', name: 'Wine' }, true)).toEqual({
      seedSlug: 'wine',
    });
  });

  it('sends an explicit null to clear', () => {
    expect(buildRatingCategoryFields(null, true)).toEqual({ categoryId: null });
  });
});
