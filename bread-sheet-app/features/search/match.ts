/**
 * Pure matching helpers for TICKET-P6-008 Slice A (personal search).
 *
 * Deliberately plain `String.includes` over normalised strings, never a regex
 * built from user input — the project's regex convention (CLAUDE.md "Regexes
 * Over User Input") exists exactly to keep a client-supplied query from ever
 * reaching a pattern that could backtrack badly, and `includes` has neither
 * problem by construction.
 */

/**
 * Case- and diacritic-insensitive normalisation. `NFKD` splits a composed
 * character (e.g. "é") into a base letter plus a combining mark, which the
 * second step then strips — "café" and "cafe" compare equal, as do "COLA"
 * and "cola".
 */
export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/**
 * True if `query` is a substring of `name` or `brand`, case- and
 * diacritic-insensitively. `brand` is nullable — a P6-007 custom product (not
 * built yet, but already modelled by `RatedProduct.brand`) has no brand, and
 * matching must not depend on one being present. An empty/whitespace-only
 * query matches everything (no filter applied).
 */
export function matchesNameOrBrand(
  query: string,
  name: string,
  brand: string | null | undefined,
): boolean {
  const q = normalizeSearchText(query.trim());
  if (!q) return true;
  if (normalizeSearchText(name).includes(q)) return true;
  if (brand != null && normalizeSearchText(brand).includes(q)) return true;
  return false;
}

/**
 * Filters a list of rating-shaped entries by product name/brand.
 *
 * `categoryPredicate` is how the Home tab's TICKET-P6-003 category chips
 * compose with the query (`category = cocktails AND query = "negroni"`): the
 * selected chip's predicate (`features/categories/filter.ts`
 * `categoryPredicateFor`) is ANDed with the name/brand match.
 */
export function filterRatingsByQuery<T extends { product: { name: string; brand: string | null } }>(
  entries: T[],
  query: string,
  categoryPredicate?: (entry: T) => boolean,
): T[] {
  return entries.filter((entry) => {
    if (categoryPredicate && !categoryPredicate(entry)) return false;
    return matchesNameOrBrand(query, entry.product.name, entry.product.brand);
  });
}
