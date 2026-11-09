/**
 * TICKET-P6-003 — the curated starting point for the category picker.
 *
 * Deliberately a shared constant, not a DB table: nothing is written per user
 * until they actually pick a seed (`POST /api/users/me/categories { seedSlug
 * }`, find-or-create on `(userId, slug)` — see `services/categoryService.ts`),
 * so a user who only rates chocolate never carries 22 unused rows or chips.
 * Mirrored client-side (`bread-sheet-app`) — the slugs and display names here
 * are the wire contract; keep both lists in lockstep.
 *
 * There is deliberately no `other` seed: "uncategorised" is the absence of a
 * category (`Rating.categoryId === null`), and a second way to say the same
 * thing would split the same ratings across two chips.
 *
 * A seed that nobody picks can be dropped from this list with no migration
 * and no effect on users who already materialised it (`isSeed: true` rows are
 * ordinary `UserCategory` rows from then on). A name that keeps showing up as
 * a *custom* category across users (see the cross-user query in
 * `docs/architecture/backend.md#custom-categories-queryable-across-users-ticket-p6-003`)
 * is the signal to promote it into this list.
 */
export interface CategorySeed {
  /** Stable identifier — also what `Product.suggestedCategory` holds and what
   * the OFF `categories_tags` rule list (`services/categorySuggestion.ts`)
   * and the plausibility prompt (`services/imagePlausibilityService.ts`) are
   * allowed to return. */
  slug: string;
  /** Display name offered as the one-tap "create" label in the picker. */
  name: string;
}

export const CATEGORY_SEEDS: readonly CategorySeed[] = [
  { slug: 'wine', name: 'Wine' },
  { slug: 'beer', name: 'Beer' },
  { slug: 'spirits', name: 'Spirits' },
  { slug: 'cocktails', name: 'Cocktails' },
  { slug: 'cigars', name: 'Cigars' },
  { slug: 'coffee', name: 'Coffee' },
  { slug: 'tea', name: 'Tea' },
  { slug: 'soft-drinks', name: 'Soft Drinks' },
  { slug: 'water', name: 'Water' },
  { slug: 'bread-bakery', name: 'Bread & Bakery' },
  { slug: 'dairy', name: 'Dairy' },
  { slug: 'cheese', name: 'Cheese' },
  { slug: 'chocolate', name: 'Chocolate' },
  { slug: 'sweets', name: 'Sweets' },
  { slug: 'snacks', name: 'Snacks' },
  { slug: 'cereals', name: 'Cereals' },
  { slug: 'meat', name: 'Meat' },
  { slug: 'fish-seafood', name: 'Fish & Seafood' },
  { slug: 'fruit-vegetables', name: 'Fruit & Vegetables' },
  { slug: 'ready-meals', name: 'Ready Meals' },
  { slug: 'sauces-condiments', name: 'Sauces & Condiments' },
  { slug: 'supplements', name: 'Supplements' },
  { slug: 'baby-food', name: 'Baby Food' },
] as const;

const SEED_SLUG_SET: ReadonlySet<string> = new Set(CATEGORY_SEEDS.map((s) => s.slug));
const SEED_BY_SLUG: ReadonlyMap<string, CategorySeed> = new Map(
  CATEGORY_SEEDS.map((s) => [s.slug, s]),
);

/** Whether `slug` is one of the curated seed slugs above. */
export function isSeedSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && SEED_SLUG_SET.has(slug);
}

/** Looks up a seed's canonical display name by slug, or `null` if unknown. */
export function getSeedBySlug(slug: string): CategorySeed | null {
  return SEED_BY_SLUG.get(slug) ?? null;
}
