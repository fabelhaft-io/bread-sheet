import { Response, NextFunction } from 'express';
import { AuthRequest } from '../middlewares/authMiddleware.js';
import {
  CategoryValidationError,
  validateCategoryCreate,
  validateCategoryMerge,
  validateCategoryRename,
} from '../validators/categoryValidator.js';
import {
  CategoryForbiddenError,
  CategoryNotFoundError,
  DuplicateCategoryNameError,
  SelfMergeError,
  TooManyCategoriesError,
  createCategory,
  deleteCategory,
  listMyCategories,
  mergeCategory,
  renameCategory,
  type CategoryWithCount,
} from '../services/categoryService.js';
import logger from '../logger.js';

/**
 * TICKET-P6-003 — `/api/users/me/categories` and its `:id` sub-routes. All
 * `requireAuth` only (no `requireRegistered`, confirmed by the ticket): a
 * category is private to the caller by construction, so none of the
 * accountability reasons behind `requireRegistered` apply.
 */

function serializeCategory(category: CategoryWithCount) {
  return {
    id: category.id,
    name: category.name,
    slug: category.slug,
    isSeed: category.isSeed,
    createdAt: category.createdAt,
    ratingCount: category.ratingCount,
  };
}

// GET /api/users/me/categories
export const listCategoriesHandler = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const categories = await listMyCategories(req.user!.id);
    res.json(categories.map(serializeCategory));
  } catch (err) {
    logger.error(err);
    next(err);
  }
};

// POST /api/users/me/categories — body `{ name }` or `{ seedSlug }`.
export const createCategoryHandler = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const input = validateCategoryCreate(req.body);
    const category = await createCategory(req.user!.id, input);
    res.status(201).json(serializeCategory(category));
  } catch (err) {
    if (err instanceof CategoryValidationError) {
      return res.status(400).json({ message: err.message, field: err.field });
    }
    if (err instanceof TooManyCategoriesError) {
      return res.status(409).json({ error: err.code, message: err.message });
    }
    next(err);
  }
};

// PATCH /api/users/me/categories/:id — body `{ name }`.
export const renameCategoryHandler = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { name } = validateCategoryRename(req.body);
    const category = await renameCategory(req.user!.id, req.params.id as string, name);
    res.json(serializeCategory(category));
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
    if (err instanceof DuplicateCategoryNameError) {
      return res
        .status(409)
        .json({ error: err.code, categoryId: err.categoryId, message: err.message });
    }
    next(err);
  }
};

// DELETE /api/users/me/categories/:id
export const deleteCategoryHandler = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    await deleteCategory(req.user!.id, req.params.id as string);
    res.status(204).send();
  } catch (err) {
    if (err instanceof CategoryNotFoundError) {
      return res.status(404).json({ error: err.code, message: err.message });
    }
    if (err instanceof CategoryForbiddenError) {
      return res.status(403).json({ error: err.code, message: err.message });
    }
    next(err);
  }
};

// POST /api/users/me/categories/:id/merge — body `{ intoId }`.
export const mergeCategoryHandler = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { intoId } = validateCategoryMerge(req.body);
    const category = await mergeCategory(req.user!.id, req.params.id as string, intoId);
    res.json(serializeCategory(category));
  } catch (err) {
    if (err instanceof CategoryValidationError) {
      return res.status(400).json({ message: err.message, field: err.field });
    }
    if (err instanceof SelfMergeError) {
      return res.status(400).json({ error: err.code, message: err.message });
    }
    if (err instanceof CategoryNotFoundError) {
      return res.status(404).json({ error: err.code, message: err.message });
    }
    if (err instanceof CategoryForbiddenError) {
      return res.status(403).json({ error: err.code, message: err.message });
    }
    next(err);
  }
};
