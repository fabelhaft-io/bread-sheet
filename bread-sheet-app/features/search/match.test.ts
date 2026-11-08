import type { RatingEntry } from '@/features/ratings/types';

import { filterRatingsByQuery, matchesNameOrBrand, normalizeSearchText } from './match';

describe('normalizeSearchText', () => {
  it('lowercases and strips diacritics', () => {
    expect(normalizeSearchText('CAFÉ')).toBe('cafe');
    expect(normalizeSearchText('Jalapeño')).toBe('jalapeno');
  });
});

describe('matchesNameOrBrand', () => {
  it('matches a substring, not just a prefix', () => {
    expect(matchesNameOrBrand('cola', 'Coca-Cola', null)).toBe(true);
    expect(matchesNameOrBrand('Cola', 'coca-cola', null)).toBe(true);
  });

  it('is case- and diacritic-insensitive', () => {
    expect(matchesNameOrBrand('CAFE', 'Café Latte', null)).toBe(true);
    expect(matchesNameOrBrand('café', 'CAFE LATTE', null)).toBe(true);
  });

  it('matches on brand as well as name', () => {
    expect(matchesNameOrBrand('artisan', 'Sourdough Loaf', 'Artisan Bakery')).toBe(true);
  });

  it('does not depend on a brand being present', () => {
    expect(matchesNameOrBrand('negroni', 'Negroni', null)).toBe(true);
    expect(matchesNameOrBrand('negroni', 'Negroni', undefined)).toBe(true);
  });

  it('returns false when neither name nor brand contains the query', () => {
    expect(matchesNameOrBrand('pepsi', 'Coca-Cola', 'Coca-Cola Company')).toBe(false);
  });

  it('treats an empty or whitespace-only query as matching everything', () => {
    expect(matchesNameOrBrand('', 'Anything', null)).toBe(true);
    expect(matchesNameOrBrand('   ', 'Anything', null)).toBe(true);
  });
});

function rating(id: string, name: string, brand: string | null, kind: 'PACKAGED' | 'CUSTOM' = 'PACKAGED'): RatingEntry {
  return {
    id,
    score: 8,
    taste: 8,
    comment: null,
    createdAt: new Date().toISOString(),
    product: { id: `p-${id}`, kind, name, brand, image: null },
  };
}

describe('filterRatingsByQuery', () => {
  it('filters by name and brand, case/diacritic-insensitively, on substrings', () => {
    const entries = [
      rating('1', 'Coca-Cola', 'Coca-Cola Company'),
      rating('2', 'Sourdough Loaf', 'Artisan Bakery'),
    ];

    expect(filterRatingsByQuery(entries, 'cola').map((e) => e.id)).toEqual(['1']);
    expect(filterRatingsByQuery(entries, 'bakery').map((e) => e.id)).toEqual(['2']);
  });

  it('returns everything, unfiltered, for an empty query', () => {
    const entries = [rating('1', 'Coca-Cola', null), rating('2', 'Rye', null)];
    expect(filterRatingsByQuery(entries, '')).toHaveLength(2);
  });

  /**
   * TICKET-P6-007 isn't built, but P6-008's AC requires matching to not
   * depend on a barcode or brand being present. A CUSTOM-kind rating with a
   * null brand is the closest fixture available today.
   */
  it('finds a barcode-less CUSTOM item by name alone (brand null)', () => {
    const entries = [rating('1', 'Negroni', null, 'CUSTOM')];
    expect(filterRatingsByQuery(entries, 'negroni')).toHaveLength(1);
    expect(filterRatingsByQuery(entries, 'NEGRONI')).toHaveLength(1);
  });

  it('composes with an optional category predicate (AND), the P6-003 hook point', () => {
    const entries = [rating('1', 'Negroni', null, 'CUSTOM'), rating('2', 'Daiquiri', null, 'CUSTOM')];
    const onlyNegronis = (e: RatingEntry) => e.product.name === 'Negroni';

    expect(filterRatingsByQuery(entries, '', onlyNegronis)).toEqual([entries[0]]);
    // A category predicate that excludes the only name match still yields nothing —
    // this is the AND composition the (not-yet-built) P6-003 chips will rely on.
    expect(filterRatingsByQuery(entries, 'daiquiri', onlyNegronis)).toEqual([]);
  });
});
