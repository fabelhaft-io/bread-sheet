import { isSeedSlug } from '../constants/categorySeeds.js';

/**
 * TICKET-P6-003 — the first of `Product.suggestedCategory`'s two sources:
 * Open Food Facts' own `categories_tags` (e.g. `en:wines`, `en:breads`),
 * mapped onto our seed slugs by an ordered rule list, first match wins. This
 * never looks at the product name — only OFF's own taxonomy tags — per the
 * ticket's "never guessed from the name alone" rule.
 *
 * Deliberately a plain array scan over small, fixed string sets — no regular
 * expressions, so the CLAUDE.md ReDoS convention doesn't apply here. OFF can
 * return dozens of tags per product; the input is still bounded by what OFF
 * itself returns for one product (never client-supplied).
 *
 * Not exhaustive by design: a tag that matches nothing falls through to
 * `null`, same as a product with no useful tags at all. Extend this list as
 * real OFF data shows gaps — it has no effect on users who already
 * materialised a different category.
 */
interface OffCategoryRule {
  slug: string;
  tags: readonly string[];
}

const OFF_CATEGORY_RULES: readonly OffCategoryRule[] = [
  { slug: 'baby-food', tags: ['en:baby-foods', 'en:baby-milks', 'en:infant-formulas'] },
  { slug: 'supplements', tags: ['en:dietary-supplements', 'en:food-supplements'] },
  { slug: 'wine', tags: ['en:wines', 'en:sparkling-wines', 'en:champagnes'] },
  { slug: 'beer', tags: ['en:beers'] },
  {
    slug: 'spirits',
    tags: ['en:spirits', 'en:liqueurs', 'en:whiskies', 'en:rums', 'en:vodkas', 'en:gins'],
  },
  { slug: 'cocktails', tags: ['en:cocktails'] },
  { slug: 'cigars', tags: ['en:cigars', 'en:tobaccos'] },
  { slug: 'coffee', tags: ['en:coffees', 'en:coffee-beans', 'en:instant-coffees'] },
  { slug: 'tea', tags: ['en:teas', 'en:iced-teas'] },
  { slug: 'water', tags: ['en:waters', 'en:mineral-waters', 'en:spring-waters'] },
  {
    slug: 'soft-drinks',
    tags: ['en:sodas', 'en:soft-drinks', 'en:fruit-drinks', 'en:energy-drinks'],
  },
  { slug: 'dairy', tags: ['en:dairies', 'en:milks', 'en:yogurts', 'en:creams'] },
  { slug: 'cheese', tags: ['en:cheeses'] },
  { slug: 'chocolate', tags: ['en:chocolates', 'en:chocolate-candies'] },
  { slug: 'sweets', tags: ['en:sweets', 'en:candies', 'en:confectioneries'] },
  { slug: 'snacks', tags: ['en:snacks', 'en:chips-and-fries', 'en:appetizers'] },
  { slug: 'cereals', tags: ['en:cereals', 'en:breakfast-cereals', 'en:cereal-bars'] },
  { slug: 'bread-bakery', tags: ['en:breads', 'en:bakery-products', 'en:pastries'] },
  { slug: 'meat', tags: ['en:meats', 'en:poultries', 'en:sausages'] },
  { slug: 'fish-seafood', tags: ['en:seafood', 'en:fishes', 'en:fishes-and-seafood'] },
  {
    slug: 'fruit-vegetables',
    tags: ['en:fruits', 'en:vegetables', 'en:fruits-and-vegetables-based-foods'],
  },
  { slug: 'sauces-condiments', tags: ['en:sauces', 'en:condiments', 'en:dressings'] },
  {
    slug: 'ready-meals',
    tags: ['en:meals', 'en:prepared-meals', 'en:ready-to-eat-meals', 'en:pizzas'],
  },
];

/**
 * First seed slug whose OFF tags intersect `categoriesTags`, or `null` if
 * none do (including when OFF returned no `categories_tags` at all).
 */
export function suggestCategoryFromOffTags(
  categoriesTags: readonly string[] | undefined | null,
): string | null {
  if (!categoriesTags || categoriesTags.length === 0) return null;
  const tagSet = new Set(categoriesTags);
  for (const rule of OFF_CATEGORY_RULES) {
    if (rule.tags.some((tag) => tagSet.has(tag))) {
      return rule.slug;
    }
  }
  return null;
}

/**
 * The second source: the `kind=product` image-plausibility response's own
 * `category` guess (see `imagePlausibilityService.ts`). Re-validated here
 * too — a value is only ever persisted if it is one of the curated seed
 * slugs, so a model hallucination or a stale client never lands an arbitrary
 * string in `Product.suggestedCategory`.
 */
export function normalizeSuggestedCategory(value: unknown): string | null {
  return isSeedSlug(value) ? value : null;
}
