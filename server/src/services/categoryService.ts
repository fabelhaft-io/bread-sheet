import prisma from '../db.js';
import { Prisma } from '../generated/prisma_client/client.js';
import { getSeedBySlug } from '../constants/categorySeeds.js';
import { slugifyCategoryName } from './categorySlug.js';
import {
  CategoryValidationError,
  type CategoryCreateInput,
  type RatingCategoryInput,
} from '../validators/categoryValidator.js';

/**
 * TICKET-P6-003 — `UserCategory` CRUD + merge, and the resolution helper the
 * rating write path (`POST /api/ratings`) uses for its optional `categoryId`
 * / `seedSlug` fields. A category is private by construction: every function
 * here either operates on the caller's own `userId` directly, or checks
 * ownership before touching a row by id.
 */

export const MAX_CATEGORIES_PER_USER = 40;

export class CategoryNotFoundError extends Error {
  readonly code = 'category_not_found';
  constructor(id: string) {
    super(`Category ${id} not found`);
  }
}

export class CategoryForbiddenError extends Error {
  readonly code = 'category_forbidden';
  constructor() {
    super('This category belongs to another user');
  }
}

export class TooManyCategoriesError extends Error {
  readonly code = 'too_many_categories';
  constructor() {
    super(`You can have at most ${MAX_CATEGORIES_PER_USER} categories`);
  }
}

export class DuplicateCategoryNameError extends Error {
  readonly code = 'duplicate_category';
  constructor(
    message: string,
    public readonly categoryId: string,
  ) {
    super(message);
  }
}

export class SelfMergeError extends Error {
  readonly code = 'self_merge';
  constructor() {
    super('Cannot merge a category into itself');
  }
}

export interface CategoryWithCount {
  id: string;
  name: string;
  slug: string;
  isSeed: boolean;
  createdAt: Date;
  ratingCount: number;
}

interface CategoryRow {
  id: string;
  userId: string;
  name: string;
  slug: string;
  isSeed: boolean;
  createdAt: Date;
}

function toCategoryWithCount(row: CategoryRow, ratingCount: number): CategoryWithCount {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    isSeed: row.isSeed,
    createdAt: row.createdAt,
    ratingCount,
  };
}

async function withRatingCount(row: CategoryRow): Promise<CategoryWithCount> {
  const ratingCount = await prisma.rating.count({ where: { categoryId: row.id } });
  return toCategoryWithCount(row, ratingCount);
}

/** Fetches a category by id and throws unless it exists AND belongs to `userId`. */
async function getOwnedCategoryOrThrow(userId: string, categoryId: string): Promise<CategoryRow> {
  const category = await prisma.userCategory.findUnique({ where: { id: categoryId } });
  if (!category) throw new CategoryNotFoundError(categoryId);
  if (category.userId !== userId) throw new CategoryForbiddenError();
  return category;
}

/**
 * GET /api/users/me/categories — every `UserCategory` row the caller has
 * materialised (seed-origin or custom), each with how many of their own
 * ratings currently carry it. A seed they have never picked simply has no
 * row, so it is absent here by construction — there is nothing to filter.
 */
export async function listMyCategories(userId: string): Promise<CategoryWithCount[]> {
  const categories = await prisma.userCategory.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  });
  if (categories.length === 0) return [];

  const counts = await prisma.rating.groupBy({
    by: ['categoryId'],
    where: { userId, categoryId: { in: categories.map((c) => c.id) } },
    _count: { _all: true },
  });
  const countByCategoryId = new Map<string, number>(
    counts
      .filter((c) => c.categoryId !== null)
      .map((c) => [c.categoryId as string, c._count._all]),
  );

  return categories.map((c) => toCategoryWithCount(c, countByCategoryId.get(c.id) ?? 0));
}

/**
 * POST /api/users/me/categories — find-or-create on `(userId, slug)`.
 * `{ seedSlug }` materialises exactly one row for a curated seed (validated
 * against `constants/categorySeeds.ts` by the caller); `{ name }` slugifies
 * + case-folds a custom name (the fragmentation guard). Returns the existing
 * row, unchanged, if the slug already exists for this user — this is what
 * makes it safe to call from the rating write path on every request that
 * carries a `seedSlug`.
 */
export async function createCategory(
  userId: string,
  input: CategoryCreateInput,
): Promise<CategoryWithCount> {
  let name: string;
  let slug: string;
  let isSeed: boolean;

  if ('seedSlug' in input) {
    const seed = getSeedBySlug(input.seedSlug);
    if (!seed) {
      // The validator already checks this; defensive only.
      throw new CategoryValidationError('seedSlug', 'seedSlug is not a recognised seed');
    }
    name = seed.name;
    slug = seed.slug;
    isSeed = true;
  } else {
    name = input.name;
    slug = slugifyCategoryName(input.name);
    isSeed = false;
    if (slug.length === 0) {
      throw new CategoryValidationError(
        'name',
        'name must contain at least one letter or digit',
      );
    }
  }

  const existing = await prisma.userCategory.findUnique({
    where: { userId_slug: { userId, slug } },
  });
  if (existing) {
    return withRatingCount(existing);
  }

  const count = await prisma.userCategory.count({ where: { userId } });
  if (count >= MAX_CATEGORIES_PER_USER) {
    throw new TooManyCategoriesError();
  }

  try {
    const created = await prisma.userCategory.create({
      data: { userId, name, slug, isSeed },
    });
    return toCategoryWithCount(created, 0);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // Race: another request created the same (userId, slug) row first —
      // find-or-create means we hand back the winner, not a 409.
      const race = await prisma.userCategory.findUnique({
        where: { userId_slug: { userId, slug } },
      });
      if (race) return withRatingCount(race);
    }
    throw err;
  }
}

/**
 * PATCH /api/users/me/categories/:id — rename. Free and retroactive: it
 * changes one row, never per-rating data. Renaming into a slug that collides
 * with another of the caller's own categories is `409 duplicate_category`
 * (pointing at the colliding row) rather than silently merging — merging is
 * its own explicit action.
 */
export async function renameCategory(
  userId: string,
  categoryId: string,
  newName: string,
): Promise<CategoryWithCount> {
  await getOwnedCategoryOrThrow(userId, categoryId);
  const slug = slugifyCategoryName(newName);
  if (slug.length === 0) {
    throw new CategoryValidationError('name', 'name must contain at least one letter or digit');
  }

  try {
    const updated = await prisma.userCategory.update({
      where: { id: categoryId },
      data: { name: newName, slug },
    });
    return withRatingCount(updated);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const collision = await prisma.userCategory.findUnique({
        where: { userId_slug: { userId, slug } },
      });
      throw new DuplicateCategoryNameError(
        `You already have a category named "${collision?.name ?? newName}"`,
        collision?.id ?? categoryId,
      );
    }
    throw err;
  }
}

/**
 * DELETE /api/users/me/categories/:id — the category disappears; its
 * ratings do not. `Rating.categoryId`'s `onDelete: SetNull` does the actual
 * work at the database layer, so there is nothing else to do here.
 */
export async function deleteCategory(userId: string, categoryId: string): Promise<void> {
  await getOwnedCategoryOrThrow(userId, categoryId);
  await prisma.userCategory.delete({ where: { id: categoryId } });
}

/**
 * POST /api/users/me/categories/:id/merge `{ intoId }` — the escape hatch
 * for a fragmented list ("Wine" and "wines" as two rows some users will
 * still manage to create before renaming catches up). Reassigns every
 * rating filed under the source to the target, then deletes the source, in
 * one transaction so a crash mid-merge can't orphan ratings.
 */
export async function mergeCategory(
  userId: string,
  sourceId: string,
  intoId: string,
): Promise<CategoryWithCount> {
  if (sourceId === intoId) throw new SelfMergeError();

  const source = await getOwnedCategoryOrThrow(userId, sourceId);
  const target = await getOwnedCategoryOrThrow(userId, intoId);

  return prisma.$transaction(async (tx) => {
    await tx.rating.updateMany({
      where: { userId, categoryId: source.id },
      data: { categoryId: target.id },
    });
    await tx.userCategory.delete({ where: { id: source.id } });
    const ratingCount = await tx.rating.count({ where: { categoryId: target.id } });
    return toCategoryWithCount(target, ratingCount);
  });
}

export type ResolvedRatingCategory =
  | { kind: 'unset' }
  | { kind: 'set'; categoryId: string | null };

/**
 * `POST /api/ratings`'s category resolution. `{ kind: 'unset' }` means the
 * caller's request carried neither `categoryId` nor `seedSlug` — the
 * ratingController must leave the rating's existing `categoryId` untouched
 * in that case (see the field's docs on `RatingCategoryInput`), which is why
 * this is a discriminated union rather than just `string | null`: `null`
 * here always means "clear it", never "don't know".
 */
export async function resolveRatingCategory(
  userId: string,
  input: RatingCategoryInput,
): Promise<ResolvedRatingCategory> {
  switch (input.kind) {
    case 'unset':
      return { kind: 'unset' };
    case 'clear':
      return { kind: 'set', categoryId: null };
    case 'id': {
      const category = await getOwnedCategoryOrThrow(userId, input.categoryId);
      return { kind: 'set', categoryId: category.id };
    }
    case 'seed': {
      const created = await createCategory(userId, { seedSlug: input.seedSlug });
      return { kind: 'set', categoryId: created.id };
    }
  }
}
