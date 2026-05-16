import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import {
  requireAuth,
  requireRegistered,
} from '../middlewares/authMiddleware.js';
import { apiLimiter, userLimiter } from '../middlewares/rateLimit.js';
import {
  getProductByBarcode,
  submitProduct,
  uploadImage,
  approveProduct,
  rejectProduct,
} from '../controllers/productController.js';
import { extractLabel } from '../controllers/labelExtractionController.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB hard ceiling
});

function handleUploadError(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'image_too_large' });
  }
  next(err);
}

router.get('/:barcode', requireAuth, userLimiter, getProductByBarcode);

router.post(  '/upload-image',
  requireAuth,
  apiLimiter,
  upload.single('image'),
  uploadImage,
  handleUploadError,
);

router.post('/extract-label', requireAuth, apiLimiter, requireRegistered, extractLabel);

// submitProduct only works with registered users
router.post('/', requireAuth, apiLimiter, requireRegistered, submitProduct);

router.post('/:barcode/verify', requireAuth, apiLimiter, requireRegistered, approveProduct);
// DELETE carries a REJECT vote — it does not retract an existing approval
router.delete('/:barcode/verify', requireAuth, apiLimiter, requireRegistered, rejectProduct);

export default router;