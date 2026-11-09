import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middlewares/authMiddleware.js';
import { syncLimiter, userLimiter } from '../middlewares/rateLimit.js';
import { isValidUuid } from '../validators/idValidator.js';
import { syncUser } from '../controllers/userController.js';
import { getMyRatings } from '../controllers/ratingController.js';
import {
  createCategoryHandler,
  deleteCategoryHandler,
  listCategoriesHandler,
  mergeCategoryHandler,
  renameCategoryHandler,
} from '../controllers/categoryController.js';

const router = Router();

router.param('id', (req: Request, res: Response, next: NextFunction, value: string) => {
  if (!isValidUuid(value)) {
    return res.status(400).json({ code: 'invalid_category_id' });
  }
  next();
});

router.post('/sync', syncLimiter, requireAuth, syncUser);
router.get('/me/ratings', requireAuth, userLimiter, getMyRatings);

// TICKET-P6-003 — requireAuth only, deliberately NOT requireRegistered: a
// category is private to the caller by construction, so none of the
// accountability arguments behind requireRegistered apply (see
// docs/architecture/backend.md#categories).
router.get('/me/categories', requireAuth, userLimiter, listCategoriesHandler);
router.post('/me/categories', requireAuth, userLimiter, createCategoryHandler);
router.patch('/me/categories/:id', requireAuth, userLimiter, renameCategoryHandler);
router.delete('/me/categories/:id', requireAuth, userLimiter, deleteCategoryHandler);
router.post('/me/categories/:id/merge', requireAuth, userLimiter, mergeCategoryHandler);

export default router;
