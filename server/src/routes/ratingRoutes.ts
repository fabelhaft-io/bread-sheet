import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middlewares/authMiddleware.js';
import { userLimiter } from '../middlewares/rateLimit.js';
import { isValidUuid } from '../validators/idValidator.js';
import {
  createRating,
  getRatingsForProduct,
} from '../controllers/ratingController.js';

const router = Router();

router.param('productId', (req: Request, res: Response, next: NextFunction, value: string) => {
  if (!isValidUuid(value)) {
    return res.status(400).json({ code: 'invalid_product_id' });
  }
  next();
});

router.post('/', requireAuth, userLimiter, createRating);
router.get('/product/:productId', requireAuth, userLimiter, getRatingsForProduct);
// GET /me/:barcode (TICKET-P6-009): deleted. Unused by the app since Phase 8
// (the product screen reads "my rating" from the cached ratings list).

export default router;
