import { CATEGORY_NAME_MAX_RAW_CHARS, validateCategoryName } from './validation';

describe('validateCategoryName', () => {
  it('accepts a normal name, trimmed', () => {
    expect(validateCategoryName('  Wine  ')).toEqual({ valid: true, name: 'Wine' });
  });

  it('rejects an empty or whitespace-only name', () => {
    expect(validateCategoryName('')).toMatchObject({ valid: false, reason: 'empty' });
    expect(validateCategoryName('   ')).toMatchObject({ valid: false, reason: 'empty' });
  });

  it('accepts exactly the cap and rejects one over it, measured on the RAW string', () => {
    const atCap = 'a'.repeat(CATEGORY_NAME_MAX_RAW_CHARS);
    const overCap = 'a'.repeat(CATEGORY_NAME_MAX_RAW_CHARS + 1);
    expect(validateCategoryName(atCap)).toMatchObject({ valid: true });
    expect(validateCategoryName(overCap)).toMatchObject({ valid: false, reason: 'too_long' });
  });

  it('measures the cap before trimming — padding alone cannot sneak under it', () => {
    const paddedOverCap = ` ${'a'.repeat(CATEGORY_NAME_MAX_RAW_CHARS)} `;
    expect(validateCategoryName(paddedOverCap)).toMatchObject({ valid: false, reason: 'too_long' });
  });
});
