import { Router } from 'express';
import { requireAuth } from '../middlewares/authMiddleware.js';
import { userLimiter } from '../middlewares/rateLimit.js';
import {
  createRating,
  getMyRatingForProduct,
  getRatingsForProduct,
} from '../controllers/ratingController.js';

const router = Router();

router.post('/', requireAuth, userLimiter, createRating);
router.get('/product/:barcode', requireAuth, userLimiter, getRatingsForProduct);
router.get('/me/:barcode', requireAuth, userLimiter, getMyRatingForProduct);

export default router;
