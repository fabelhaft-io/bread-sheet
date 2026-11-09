/**
 * Seed labels for the category picker (TICKET-P6-003) — a curated starting
 * point, explicitly expected to churn. Nothing is written for a user until
 * they pick one (find-or-create on `POST /api/users/me/categories`), so a
 * seed never costs a row, or a Home-tab chip, before someone actually uses
 * it.
 *
 * Mirrors `server/src/constants/categorySeeds.ts`.
 *
 * ASSUMPTION flagged for the reviewer: the backend half of TICKET-P6-003 had
 * not yet committed that file when this list was written (parallel
 * implementation, this is the frontend half). The 23 slugs below are taken
 * verbatim from the ticket text; the display `name` for each is this agent's
 * own choice and has NOT been cross-checked against the server's constant.
 * Reconcile casing/punctuation against `server/src/constants/categorySeeds.ts`
 * once it lands, before this ships.
 */

export interface CategorySeed {
  slug: string;
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

export function findSeedBySlug(slug: string | null | undefined): CategorySeed | null {
  if (!slug) return null;
  return CATEGORY_SEEDS.find((seed) => seed.slug === slug) ?? null;
}
