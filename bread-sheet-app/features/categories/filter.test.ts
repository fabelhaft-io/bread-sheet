import type { RatingEntry } from '@/features/ratings/types';

import {
  ALL_FILTER,
  UNCATEGORIZED_CHIP_ID,
  UNCATEGORIZED_FILTER,
  buildCategoryChips,
  categoryPredicateFor,
  isSelectionVisible,
} from './filter';

function rating(id: string, category: RatingEntry['category']): RatingEntry {
  return {
    id,
    score: 8,
    taste: 8,
    comment: null,
    createdAt: new Date().toISOString(),
    product: { id: `p-${id}`, kind: 'PACKAGED', name: `Product ${id}`, brand: null, image: null },
    category,
  };
}

describe('buildCategoryChips', () => {
  it('returns one chip per category with an accurate count, most-used first', () => {
    const entries = [
      rating('1', { id: 'cat-wine', name: 'Wine' }),
      rating('2', { id: 'cat-wine', name: 'Wine' }),
      rating('3', { id: 'cat-cocktails', name: 'Cocktails' }),
    ];
    expect(buildCategoryChips(entries)).toEqual([
      { id: 'cat-wine', name: 'Wine', count: 2 },
      { id: 'cat-cocktails', name: 'Cocktails', count: 1 },
    ]);
  });

  it('appends an Uncategorised chip last, only when something is uncategorised', () => {
    const withUncategorized = [rating('1', { id: 'cat-wine', name: 'Wine' }), rating('2', null)];
    const chips = buildCategoryChips(withUncategorized);
    expect(chips[chips.length - 1]).toEqual({ id: UNCATEGORIZED_CHIP_ID, name: 'Uncategorised', count: 1 });

    const allCategorized = [rating('1', { id: 'cat-wine', name: 'Wine' })];
    expect(buildCategoryChips(allCategorized).some((c) => c.id === UNCATEGORIZED_CHIP_ID)).toBe(false);
  });

  it('returns an empty list for no ratings', () => {
    expect(buildCategoryChips([])).toEqual([]);
  });

  it('never produces a chip for a category with zero current ratings', () => {
    // A category existing server-side with no ratings currently tagging it
    // (none ever did, or they were all re-tagged) must not appear — the row
    // only reflects what is actually in front of the user.
    const entries = [rating('1', { id: 'cat-wine', name: 'Wine' })];
    const chips = buildCategoryChips(entries);
    expect(chips.find((c) => c.id === 'cat-cocktails')).toBeUndefined();
  });
});

describe('categoryPredicateFor', () => {
  const wineEntry = rating('1', { id: 'cat-wine', name: 'Wine' });
  const uncategorizedEntry = rating('2', null);

  it('is undefined for "All" — no filter applied', () => {
    expect(categoryPredicateFor(ALL_FILTER)).toBeUndefined();
  });

  it('matches only entries with no category for "Uncategorised"', () => {
    const predicate = categoryPredicateFor(UNCATEGORIZED_FILTER)!;
    expect(predicate(wineEntry)).toBe(false);
    expect(predicate(uncategorizedEntry)).toBe(true);
  });

  it('matches only entries with the selected category id', () => {
    const predicate = categoryPredicateFor({ kind: 'category', id: 'cat-wine', name: 'Wine' })!;
    expect(predicate(wineEntry)).toBe(true);
    expect(predicate(uncategorizedEntry)).toBe(false);
  });
});

describe('isSelectionVisible', () => {
  const chips = [
    { id: 'cat-wine', name: 'Wine', count: 2 },
    { id: UNCATEGORIZED_CHIP_ID, name: 'Uncategorised', count: 1 },
  ];

  it('"All" is always visible', () => {
    expect(isSelectionVisible(ALL_FILTER, [])).toBe(true);
    expect(isSelectionVisible(ALL_FILTER, chips)).toBe(true);
  });

  it('a category selection is visible only while its chip exists', () => {
    expect(isSelectionVisible({ kind: 'category', id: 'cat-wine', name: 'Wine' }, chips)).toBe(true);
    expect(isSelectionVisible({ kind: 'category', id: 'cat-gone', name: 'Gone' }, chips)).toBe(false);
  });

  it('"Uncategorised" is visible only while at least one rating lacks a category', () => {
    expect(isSelectionVisible(UNCATEGORIZED_FILTER, chips)).toBe(true);
    expect(isSelectionVisible(UNCATEGORIZED_FILTER, [chips[0]])).toBe(false);
  });
});
