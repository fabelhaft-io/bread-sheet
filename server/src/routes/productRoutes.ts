import { Router } from 'express';
import {
  requireAuth,
  requireRegistered,
} from '../middlewares/authMiddleware.js';
import { userLimiter } from '../middlewares/rateLimit.js';
import {
  getProductByBarcode,
  submitProduct,
} from '../controllers/productController.js';

const router = Router();

router.get('/:barcode', requireAuth, userLimiter, getProductByBarcode);
router.post('/products', requireAuth, requireRegistered, submitProduct);

export default router;
