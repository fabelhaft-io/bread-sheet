import { describe, it, expect } from 'vitest';
import { slugifyCategoryName } from './categorySlug.js';

describe('slugifyCategoryName', () => {
  it('lowercases', () => {
    expect(slugifyCategoryName('WINE')).toBe('wine');
  });

  it('strips diacritics', () => {
    expect(slugifyCategoryName('Négroni')).toBe('negroni');
  });

  it('collapses whitespace/punctuation runs into a single dash', () => {
    expect(slugifyCategoryName('Bread & Bakery')).toBe('bread-bakery');
    expect(slugifyCategoryName('Soft   Drinks')).toBe('soft-drinks');
  });

  it('trims leading/trailing dashes', () => {
    expect(slugifyCategoryName('  Wine!  ')).toBe('wine');
  });

  it('"Wine", "wine" and "WINE " all produce the same slug', () => {
    const slugs = new Set(['Wine', 'wine', 'WINE '].map(slugifyCategoryName));
    expect(slugs.size).toBe(1);
    expect(slugs.has('wine')).toBe(true);
  });

  it('matches the seed slugs for seed display names (sanity check)', () => {
    expect(slugifyCategoryName('Fish & Seafood')).toBe('fish-seafood');
    expect(slugifyCategoryName('Fruit & Vegetables')).toBe('fruit-vegetables');
    expect(slugifyCategoryName('Sauces & Condiments')).toBe('sauces-condiments');
  });

  it('returns an empty string for input with no letters or digits', () => {
    expect(slugifyCategoryName('!!!')).toBe('');
  });
});
