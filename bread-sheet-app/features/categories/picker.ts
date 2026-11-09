import type { UserCategory } from './types';
import { CATEGORY_SEEDS, findSeedBySlug } from './seeds';

/**
 * Pure logic behind the rating screen's category row/picker (TICKET-P6-003).
 * Lives here, not in `app/(app)/product/[id].tsx` or
 * `components/category-picker-sheet.tsx`, so both stay UI-only — the same
 * convention `features/products/edit-form.ts` and `features/products/custom.ts`
 * set.
 */

/**
 * What the rating screen has selected for the current rating. `existing`
 * already has a server-side `UserCategory` id; `seed` is a seed the user
 * has chosen but that has not (yet) been materialised into a real category
 * row — selecting a seed online always tries to materialise it immediately
 * (`createCategory({ seedSlug })`), but offline that call cannot be made, so
 * the selection is carried as `seed` and resolved server-side when the
 * rating itself is eventually sent (`POST /api/ratings` accepts `seedSlug`
 * directly, and the outbox replay does the same).
 */
export type CategorySelection =
  | { kind: 'existing'; id: string; name: string }
  | { kind: 'seed'; slug: string; name: string };

/**
 * Maps `ProductDetail.suggestedCategory` onto the user's own list, per the
 * ticket's pre-selection rule: an own category with that slug wins outright
 * (returned as `existing`, already selected); otherwise, if the slug is a
 * known seed, it is offered unmaterialised (`seed`) — a one-tap create, not
 * an automatic one. `null` when there is no suggestion or the slug maps to
 * neither (an unknown/retired seed).
 */
export function mapSuggestion(
  suggestedCategory: string | null | undefined,
  own: readonly UserCategory[],
): CategorySelection | null {
  if (!suggestedCategory) return null;
  const existing = own.find((category) => category.slug === suggestedCategory);
  if (existing) return { kind: 'existing', id: existing.id, name: existing.name };
  const seed = findSeedBySlug(suggestedCategory);
  return seed ? { kind: 'seed', slug: seed.slug, name: seed.name } : null;
}

/** Own categories, most-used first; ties broken alphabetically for a stable order. */
export function sortOwnCategories(own: readonly UserCategory[]): UserCategory[] {
  return [...own].sort((a, b) => b.ratingCount - a.ratingCount || a.name.localeCompare(b.name));
}

/** Seeds the user has not yet materialised into their own category list. */
export function unusedSeeds(own: readonly UserCategory[]) {
  const ownSlugs = new Set(own.map((category) => category.slug));
  return CATEGORY_SEEDS.filter((seed) => !ownSlugs.has(seed.slug));
}

/**
 * The wire fields a rating write should carry for the current selection.
 * `touched` is whatever the screen considers "the user made an explicit
 * decision this session" (selecting a suggestion counts, since it is a real
 * choice even though no tap was strictly required to apply it). Per the
 * backend contract: omitting both fields (`{}`) leaves an existing rating's
 * category unchanged; sending `categoryId: null` explicitly clears it. Keys
 * with an `undefined` value are dropped by `JSON.stringify`, so spreading
 * this object straight into a request body is always correct.
 */
export function buildRatingCategoryFields(
  selection: CategorySelection | null,
  touched: boolean,
): { categoryId?: string | null; seedSlug?: string } {
  if (!touched) return {};
  if (!selection) return { categoryId: null };
  if (selection.kind === 'existing') return { categoryId: selection.id };
  return { seedSlug: selection.slug };
}
