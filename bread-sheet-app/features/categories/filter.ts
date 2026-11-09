import type { RatingEntry } from '@/features/ratings/types';

/**
 * Home tab category chip row (TICKET-P6-003). Derived purely from the
 * already-cached `/api/users/me/ratings` list — no request, works offline —
 * mirroring how `features/search/match.ts` filters the same list for the
 * Mine-scope search box. The two compose: `categoryPredicateFor` below is
 * built to be passed straight into `filterRatingsByQuery`'s optional
 * `categoryPredicate` parameter.
 */

/** Sentinel id for the synthetic "Uncategorised" chip — never a real `UserCategory.id`. */
export const UNCATEGORIZED_CHIP_ID = '__uncategorized__';

export interface CategoryChip {
  id: string;
  name: string;
  count: number;
}

export type CategoryFilterSelection =
  | { kind: 'all' }
  | { kind: 'category'; id: string; name: string }
  | { kind: 'uncategorized' };

export const ALL_FILTER: CategoryFilterSelection = { kind: 'all' };
export const UNCATEGORIZED_FILTER: CategoryFilterSelection = { kind: 'uncategorized' };

/**
 * One chip per category the user actually has ratings in, most-used first,
 * plus "Uncategorised" last when at least one rating has no category. A
 * category with zero current ratings (nothing ever tagged it, or its last
 * rating was re-tagged elsewhere) gets no chip — the row only ever shows
 * what the list in front of the user actually contains.
 */
export function buildCategoryChips(ratings: readonly RatingEntry[]): CategoryChip[] {
  const counts = new Map<string, { name: string; count: number }>();
  let uncategorized = 0;

  for (const entry of ratings) {
    if (entry.category) {
      const existing = counts.get(entry.category.id);
      if (existing) existing.count += 1;
      else counts.set(entry.category.id, { name: entry.category.name, count: 1 });
    } else {
      uncategorized += 1;
    }
  }

  const chips: CategoryChip[] = Array.from(counts.entries())
    .map(([id, value]) => ({ id, name: value.name, count: value.count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  if (uncategorized > 0) {
    chips.push({ id: UNCATEGORIZED_CHIP_ID, name: 'Uncategorised', count: uncategorized });
  }
  return chips;
}

/**
 * Builds `filterRatingsByQuery`'s optional `categoryPredicate` from the
 * selected chip. `undefined` for "All" matches that parameter's existing
 * "no filter" contract exactly, so composing search with the chip is just
 * passing this straight through.
 */
export function categoryPredicateFor(
  selection: CategoryFilterSelection,
): ((entry: RatingEntry) => boolean) | undefined {
  if (selection.kind === 'all') return undefined;
  if (selection.kind === 'uncategorized') return (entry) => entry.category === null;
  return (entry) => entry.category?.id === selection.id;
}

/**
 * True if the current selection still corresponds to a visible chip. Used to
 * fall back to "All" when a category disappears from under the selection —
 * deleted, merged away, or its last rating re-tagged elsewhere.
 */
export function isSelectionVisible(
  selection: CategoryFilterSelection,
  chips: readonly CategoryChip[],
): boolean {
  if (selection.kind === 'all') return true;
  if (selection.kind === 'uncategorized') return chips.some((chip) => chip.id === UNCATEGORIZED_CHIP_ID);
  return chips.some((chip) => chip.id === selection.id);
}
