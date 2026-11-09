import { describe, it, expect } from 'vitest';
import { normalizeProductName } from './nameNormalization.js';

describe('normalizeProductName', () => {
  it('lowercases', () => {
    expect(normalizeProductName('Negroni')).toBe('negroni');
  });

  it('strips diacritics via NFKD decomposition', () => {
    expect(normalizeProductName('Négroni')).toBe('negroni');
  });

  it('collapses internal whitespace and trims', () => {
    expect(normalizeProductName('  Negroni   Sbagliato  ')).toBe('negroni sbagliato');
  });

  it('treats "Negroni", "negroni" and "Négroni " as the same key', () => {
    const keys = new Set(['Negroni', 'negroni', 'Négroni '].map(normalizeProductName));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe('negroni');
  });

  it('is a pure function of the input only', () => {
    const input = 'Whisky Sour';
    expect(normalizeProductName(input)).toBe(normalizeProductName(input));
  });
});
