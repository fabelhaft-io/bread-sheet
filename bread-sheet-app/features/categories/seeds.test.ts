import { CATEGORY_SEEDS, findSeedBySlug } from './seeds';

describe('CATEGORY_SEEDS', () => {
  it('has no duplicate slugs', () => {
    const slugs = CATEGORY_SEEDS.map((seed) => seed.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('has a non-empty display name for every seed', () => {
    for (const seed of CATEGORY_SEEDS) {
      expect(seed.name.trim().length).toBeGreaterThan(0);
    }
  });

  // There is no "other" seed (ticket): uncategorised is the absence of a
  // category, and a second way to say the same thing would split ratings
  // across two chips for no reason.
  it('has no "other" seed', () => {
    expect(CATEGORY_SEEDS.some((seed) => seed.slug === 'other')).toBe(false);
  });
});

describe('findSeedBySlug', () => {
  it('finds a known seed', () => {
    expect(findSeedBySlug('wine')).toEqual({ slug: 'wine', name: 'Wine' });
  });

  it('returns null for an unknown slug', () => {
    expect(findSeedBySlug('unknown-seed')).toBeNull();
  });

  it('returns null for null/undefined', () => {
    expect(findSeedBySlug(null)).toBeNull();
    expect(findSeedBySlug(undefined)).toBeNull();
  });
});
