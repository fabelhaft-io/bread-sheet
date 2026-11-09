import { findNearMatch, nameSimilarity } from './match';

describe('nameSimilarity', () => {
  it('is 1 for an exact match, case/diacritic-insensitive', () => {
    expect(nameSimilarity('Wine', 'wine')).toBe(1);
    expect(nameSimilarity('café', 'CAFE')).toBe(1);
  });

  it('is high for a near-miss typo', () => {
    expect(nameSimilarity('Win', 'Wine')).toBeGreaterThanOrEqual(0.7);
  });

  it('is low for unrelated names', () => {
    expect(nameSimilarity('Wine', 'Cigars')).toBeLessThan(0.5);
  });

  it('handles empty strings without throwing', () => {
    expect(nameSimilarity('', '')).toBe(1);
    expect(nameSimilarity('', 'Wine')).toBeLessThan(1);
  });
});

describe('findNearMatch', () => {
  const candidates = [{ name: 'Wine' }, { name: 'Cigars' }, { name: 'Soft Drinks' }];

  it('finds the closest candidate above the threshold', () => {
    expect(findNearMatch('Win', candidates)).toEqual({ name: 'Wine' });
  });

  it('returns null when nothing is close enough', () => {
    expect(findNearMatch('Baby Food', candidates)).toBeNull();
  });

  it('returns null for an empty query', () => {
    expect(findNearMatch('', candidates)).toBeNull();
    expect(findNearMatch('   ', candidates)).toBeNull();
  });

  it('returns null when there are no candidates', () => {
    expect(findNearMatch('Wine', [])).toBeNull();
  });

  it('picks the best score, not just the first match over the threshold', () => {
    const closeAndCloser = [{ name: 'Win' }, { name: 'Wine' }];
    expect(findNearMatch('Wine', closeAndCloser)).toEqual({ name: 'Wine' });
  });
});
