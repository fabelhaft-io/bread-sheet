import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import {
  requireAuth,
  requireRegistered,
} from '../middlewares/authMiddleware.js';
import { apiLimiter, userLimiter } from '../middlewares/rateLimit.js';
import { requestDeadline } from '../middlewares/requestDeadline.js';
import { isValidUuid } from '../validators/idValidator.js';
import {
  getProductByGtin,
  getProductById,
  submitProduct,
  uploadImage,
  approveProduct,
  rejectProduct,
} from '../controllers/productController.js';
import { extractLabel } from '../controllers/labelExtractionController.js';
import {
  correctProduct,
  createProductEdit,
  getPendingProductEdit,
  voteOnProductEdit,
  retractVoteOnProductEdit,
  dismissProductEdit,
} from '../controllers/productEditController.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 }, // 4 MB hard ceiling
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

// TICKET-P6-009: every product is keyed by Product.id (a UUID), not a GTIN.
// Any route with a `:productId` segment 400s on a non-UUID value before the
// controller runs.
router.param('productId', (req: Request, res: Response, next: NextFunction, value: string) => {
  if (!isValidUuid(value)) {
    return res.status(400).json({ code: 'invalid_product_id' });
  }
  next();
});

// GET /gtin/:gtin is registered before /:productId — they're different
// segment counts so Express wouldn't actually collide, but the ordering
// keeps the two lookups visually (and historically) distinct.
router.get('/gtin/:gtin', requireAuth, userLimiter, getProductByGtin);
router.get('/:productId', requireAuth, userLimiter, getProductById);

// The two synchronous Gemini paths. `requestDeadline` is the outer half of the
// budget in ADR 0003 § step 0 — the inner half is `withGeminiDeadline` around
// the model call itself. Both must stay comfortably below API Gateway's fixed
// 30 s integration timeout, which answers with an opaque 504 and loses the
// upload. The plausibility check on every upload runs a
// paid Gemini call before anything is persisted. Anonymous sessions can never turn
// an upload into a product anyway (add-product.tsx turns guests away client-side
// and POST /api/products is requireRegistered).
router.post(  '/upload-image',
  requireAuth,
  apiLimiter,
  requireRegistered,
  requestDeadline(),
  upload.single('image'),
  uploadImage,
  handleUploadError,
);

router.post(
  '/extract-label',
  requireAuth,
  apiLimiter,
  requireRegistered,
  requestDeadline(),
  upload.single('image'),
  handleUploadError,
  extractLabel,
);

// submitProduct only works with registered users
router.post('/', requireAuth, apiLimiter, requireRegistered, submitProduct);

router.post('/:productId/verify', requireAuth, apiLimiter, requireRegistered, approveProduct);
// DELETE carries a REJECT vote — it does not retract an existing approval
router.delete('/:productId/verify', requireAuth, apiLimiter, requireRegistered, rejectProduct);

// --- Product editing & peer review (TICKET-P5-006) ---
// All write paths are registered-users-only. Static '/edits/...' segments never
// collide with '/:productId' — the param is validated as a UUID, and 'edits'
// is not one.

// In-place correction of a PENDING_REVIEW submission (restarts the review cycle)
router.patch('/:productId', requireAuth, apiLimiter, requireRegistered, correctProduct);

// Proposal flow for VERIFIED products
router.post('/:productId/edits', requireAuth, apiLimiter, requireRegistered, createProductEdit);
router.get('/:productId/edits/pending', requireAuth, userLimiter, getPendingProductEdit);

// Peer review of a proposal
router.post('/edits/:editId/votes', requireAuth, apiLimiter, requireRegistered, voteOnProductEdit);
router.delete('/edits/:editId/votes', requireAuth, apiLimiter, requireRegistered, retractVoteOnProductEdit);
router.post('/edits/:editId/dismissals', requireAuth, apiLimiter, requireRegistered, dismissProductEdit);

export default router;
