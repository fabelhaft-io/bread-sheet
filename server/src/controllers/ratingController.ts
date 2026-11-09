import { Response, NextFunction } from 'express';
import prisma from '../db.js';
import { AuthRequest } from '../middlewares/authMiddleware.js';
import { resolveImageUrl } from '../services/imageService.js';
import { visibleProductWhere } from '../services/productVisibility.js';
import { isValidUuid } from '../validators/idValidator.js';
import {
  CategoryValidationError,
  validateRatingCategoryFields,
} from '../validators/categoryValidator.js';
import {
  CategoryForbiddenError,
  CategoryNotFoundError,
  resolveRatingCategory,
} from '../services/categoryService.js';
import logger from '../logger.js';

// `{ id, name } | null` — TICKET-P6-003. Deliberately not included on
// `getRatingsForProduct`'s response: a category is private to the rating's
// own author, and that endpoint lists ratings from potentially many users.
const RATING_CATEGORY_SELECT = { select: { id: true, name: true } } as const;

// Minimal product shape embedded on a rating response (TICKET-P6-009 decision
// 2): `{ id, kind, name, brand, image }`. The GTIN is not needed here — the
// client already has it if it navigated here from a product screen.
const RATING_PRODUCT_SELECT = {
  id: true,
  kind: true,
  name: true,
  brand: true,
  image: true,
} as const;

/** Resolve the stored image key to a public URL on a rating's included product. */
function withResolvedProductImage<T extends { product: { image: string | null } }>(
  rating: T,
): T {
  return {
    ...rating,
    product: { ...rating.product, image: resolveImageUrl(rating.product?.image) },
  };
}

// POST /api/ratings
// Body: { productId, taste, comment?, categoryId?, seedSlug? }
// taste: Float 0–10 in 0.5 increments (e.g. 0, 0.5, 1, ..., 10)
//
// Upsert semantics: there is one rating per (user, product). Re-rating the
// same product overwrites the previous score and comment in place.
//   - 201 Created — first rating for this (user, product) pair
//   - 200 OK      — existing rating updated
//
// TICKET-P6-003 category semantics (documented here because they're the part
// an offline-replay client must get exactly right):
//   - `categoryId` omitted AND `seedSlug` omitted: the rating's category is
//     left UNTOUCHED on an update (and defaults to none on a first-time
//     create). This is what makes the offline rating outbox's last-write-wins
//     replay of `POST /api/ratings` safe — a stale retry that never knew
//     about a category someone since assigned must not wipe it.
//   - `categoryId: null` explicitly: clears the category.
//   - `categoryId: "<uuid>"`: must be one of the caller's own categories
//     (404 if the id doesn't exist, 403 if it belongs to someone else).
//   - `seedSlug: "<slug>"`: find-or-create that seed for the caller in the
//     same request, then assign it — rating and categorising in one round
//     trip.
//   - `categoryId` and `seedSlug` together is a 400 (ambiguous).
export const createRating = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.id;
    const { productId, taste, comment } = req.body;

    if (!productId || taste == null) {
      return res.status(400).json({ message: 'productId and taste are required' });
    }
    if (!isValidUuid(productId)) {
      return res.status(400).json({ message: 'productId must be a valid id' });
    }

    // Validate taste is in range and on a 0.5 boundary
    const tasteNum = Number(taste);
    if (
      isNaN(tasteNum) ||
      tasteNum < 0 ||
      tasteNum > 10 ||
      (tasteNum * 2) % 1 !== 0  // must be a multiple of 0.5
    ) {
      return res.status(400).json({ message: 'taste must be between 0 and 10 in 0.5 increments' });
    }

    let categoryResolution;
    try {
      const categoryInput = validateRatingCategoryFields(req.body as Record<string, unknown>);
      categoryResolution = await resolveRatingCategory(userId, categoryInput);
    } catch (err) {
      if (err instanceof CategoryValidationError) {
        return res.status(400).json({ message: err.message, field: err.field });
      }
      if (err instanceof CategoryNotFoundError) {
        return res.status(404).json({ error: err.code, message: err.message });
      }
      if (err instanceof CategoryForbiddenError) {
        return res.status(403).json({ error: err.code, message: err.message });
      }
      throw err;
    }

    const product = await prisma.product.findFirst({
      where: { id: productId, ...visibleProductWhere(req.user) },
    });
    if (!product) {
      return res.status(404).json({ message: 'Product not found. Fetch it via GET /api/products/gtin/:gtin first.' });
    }

    const commentValue = comment ?? null;

    const existing = await prisma.rating.findUnique({
      where: { userId_productId: { userId, productId: product.id } },
      select: { id: true },
    });

    // `categoryId` is only ever included in `create`/`update` when the
    // caller's request actually said something about it — see the semantics
    // comment above. Leaving the key out of `update` is what preserves an
    // existing category on an omitted-field replay.
    const categoryData =
      categoryResolution.kind === 'set' ? { categoryId: categoryResolution.categoryId } : {};

    const rating = await prisma.rating.upsert({
      where: { userId_productId: { userId, productId: product.id } },
      create: {
        userId,
        productId: product.id,
        taste: tasteNum,
        score: tasteNum,  // score mirrors taste (single dimension)
        comment: commentValue,
        ...categoryData,
      },
      update: {
        taste: tasteNum,
        score: tasteNum,
        comment: commentValue,
        ...categoryData,
      },
      include: {
        product: { select: RATING_PRODUCT_SELECT },
        category: RATING_CATEGORY_SELECT,
      },
    });

    const action = existing ? 'updated' : 'created';
    logger.info(`Rating ${action} by ${userId} for product ${productId}: taste=${tasteNum}`);
    res.status(existing ? 200 : 201).json(withResolvedProductImage(rating));
  } catch (error) {
    logger.error(error);
    next(error);
  }
};

// GET /api/ratings/product/:productId
// Returns all ratings for a product, most recent first
export const getRatingsForProduct = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const productId = req.params.productId as string;

    const product = await prisma.product.findFirst({
      where: { id: productId, ...visibleProductWhere(req.user) },
    });
    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    const ratings = await prisma.rating.findMany({
      where: { productId: product.id },
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, username: true, avatar: true } },
      },
    });

    res.json(ratings);
  } catch (error) {
    logger.error(error);
    next(error);
  }
};

// GET /api/users/me/ratings
// Returns the authenticated user's rating history with product details.
// TICKET-P6-003: each entry includes `category: { id, name } | null` — the
// offline chip filter and its counts are computed client-side over this
// payload, so the category has to travel with it.
export const getMyRatings = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.id;

    const ratings = await prisma.rating.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: {
        product: { select: RATING_PRODUCT_SELECT },
        category: RATING_CATEGORY_SELECT,
      },
    });

    res.json(ratings.map(withResolvedProductImage));
  } catch (error) {
    logger.error(error);
    next(error);
  }
};
