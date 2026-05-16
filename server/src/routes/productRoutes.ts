import { Router } from 'express';
import {
  requireAuth,
  requireRegistered,
} from '../middlewares/authMiddleware.js';
import { apiLimiter, userLimiter } from '../middlewares/rateLimit.js';
import {
  getProductByBarcode,
  submitProduct,
} from '../controllers/productController.js';

const router = Router();

router.get('/:barcode', requireAuth, userLimiter, getProductByBarcode);
// submitProduct only works with registered users
router.post('/', requireAuth, apiLimiter, requireRegistered, submitProduct);

export default router;
