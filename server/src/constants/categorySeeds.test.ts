import { describe, it, expect } from 'vitest';
import { CATEGORY_SEEDS, getSeedBySlug, isSeedSlug } from './categorySeeds.js';

describe('categorySeeds', () => {
  it('has no "other" seed — uncategorised is the absence of a category', () => {
    expect(CATEGORY_SEEDS.some((s) => s.slug === 'other')).toBe(false);
  });

  it('has 23 seeds, matching the ticket\'s list', () => {
    expect(CATEGORY_SEEDS).toHaveLength(23);
  });

  it('every slug is unique', () => {
    const slugs = CATEGORY_SEEDS.map((s) => s.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('isSeedSlug recognises a known seed and rejects an unknown one', () => {
    expect(isSeedSlug('wine')).toBe(true);
    expect(isSeedSlug('not-a-seed')).toBe(false);
    expect(isSeedSlug(42)).toBe(false);
    expect(isSeedSlug(undefined)).toBe(false);
  });

  it('getSeedBySlug returns the canonical name, or null for an unknown slug', () => {
    expect(getSeedBySlug('wine')).toEqual({ slug: 'wine', name: 'Wine' });
    expect(getSeedBySlug('not-a-seed')).toBeNull();
  });
});
