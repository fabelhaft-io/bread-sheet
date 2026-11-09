/**
 * TICKET-P6-003 — the fragmentation guard behind `UserCategory.slug`.
 *
 * "Wine", "wine" and "WINE " must all resolve to the same row for a given
 * user: Unicode NFKD decomposition, strip combining-mark diacritics,
 * lowercase, collapse runs of anything that isn't `[a-z0-9]` into a single
 * `-`, trim leading/trailing `-`. Mirrors the shape of
 * `services/nameNormalization.ts` (used for `Product.nameKey`) but produces
 * a dash-joined slug (`bread-bakery`, `soft-drinks`) rather than a
 * space-joined key, matching the seed slugs in `constants/categorySeeds.ts`.
 *
 * Regex safety (CLAUDE.md convention): every quantifier here is applied to a
 * single, disjoint character class with nothing adjacent sharing it, so none
 * of these can backtrack super-linearly. Callers cap the raw `name` length
 * (24 chars, `validators` — see `validateCategoryName`) before this ever
 * runs.
 */
export function slugifyCategoryName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
