import { describe, it, expect } from 'vitest';
import { normalizeSuggestedCategory, suggestCategoryFromOffTags } from './categorySuggestion.js';

describe('suggestCategoryFromOffTags', () => {
  it('returns null when categories_tags is missing, null, or empty', () => {
    expect(suggestCategoryFromOffTags(undefined)).toBeNull();
    expect(suggestCategoryFromOffTags(null)).toBeNull();
    expect(suggestCategoryFromOffTags([])).toBeNull();
  });

  it('maps a known OFF tag to its seed slug', () => {
    expect(suggestCategoryFromOffTags(['en:beverages', 'en:wines'])).toBe('wine');
    expect(suggestCategoryFromOffTags(['en:breads'])).toBe('bread-bakery');
  });

  it('returns null when no tag matches any rule', () => {
    expect(suggestCategoryFromOffTags(['en:some-unmapped-tag'])).toBeNull();
  });

  it('first matching rule wins regardless of tag order', () => {
    // en:wines (wine) appears before en:dietary-supplements (supplements) in
    // the rule list, but the rule list order decides, not array order.
    expect(suggestCategoryFromOffTags(['en:dietary-supplements', 'en:wines'])).toBe(
      'supplements',
    );
  });

  it('never consults the product name — only tags', () => {
    // No name parameter exists on this function at all; this test documents
    // that invariant structurally rather than by inspection.
    expect(suggestCategoryFromOffTags.length).toBe(1);
  });
});

describe('normalizeSuggestedCategory', () => {
  it('passes through a known seed slug', () => {
    expect(normalizeSuggestedCategory('wine')).toBe('wine');
  });

  it('coerces an unknown value to null', () => {
    expect(normalizeSuggestedCategory('made-up')).toBeNull();
    expect(normalizeSuggestedCategory(42)).toBeNull();
    expect(normalizeSuggestedCategory(undefined)).toBeNull();
    expect(normalizeSuggestedCategory(null)).toBeNull();
  });
});
