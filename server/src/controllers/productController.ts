import { Response, NextFunction } from 'express';
import { fileTypeFromBuffer } from 'file-type';
import prisma from '../db.js';
import {
  createSubmittedProduct,
  fetchFromOpenFoodFacts,
  ProductAlreadyVerifiedError,
  ProductPendingByAnotherUserError,
  ProductPreviouslyRejectedError,
} from '../services/productService.js';
import {
  castVote,
  ProductNotFoundError,
  ProductNotPendingError,
  SelfVerificationError,
} from '../services/productVerificationService.js';
import { uploadImageToS3, type ImageKind } from '../services/imageService.js';
import { checkImage, type Verdict } from '../services/imagePlausibilityService.js';
import logger from '../logger.js';
import { AuthRequest } from '../middlewares/authMiddleware.js';
import {
  SubmissionValidationError,
  validateProductSubmission,
} from '../validators/productSubmissionValidator.js';
import { ProductStatus, VerificationVote } from '../generated/prisma_client/enums.js';

const SUPPORTED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/webp',
  'image/png',
  'image/gif',
  'image/tiff',
  'image/avif',
]);

// Barcodes are EAN-8, UPC-A (12 digits), or EAN-13 — all numeric.
const BARCODE_RE = /^\d{8,13}$/;

// User-facing copy per rejection verdict. The model's own `reason` is kept
// server-side (logs + moderation record) and never forwarded to the client —
// for `abuse` especially, the client message is deliberately generic.
const REJECTION_MESSAGES: Record<Exclude<Verdict, 'ok'>, string> = {
  not_a_product:
    "This doesn't look like a food product. Please photograph the product itself.",
  unusable:
    "We couldn't make out that photo. Try again in better light and a little closer.",
  abuse: 'This image cannot be used.',
};

// GET /api/products/:barcode
export const getProductByBarcode = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const barcode = req.params.barcode as string;

    if (!BARCODE_RE.test(barcode)) {
      return res.status(400).json({ message: 'Invalid barcode format' });
    }

    // 1. Check local cache first
    const cached = await prisma.product.findUnique({ where: { barcode } });
    if (cached) {
      // PENDING_REVIEW products are invisible to anonymous callers
      if (cached.status === ProductStatus.PENDING_REVIEW && req.user?.isAnonymous) {
        return res.status(404).json({ message: 'Product not found' });
      }

      logger.info(`Product cache hit: ${barcode}`);
      const unverified = cached.status !== ProductStatus.VERIFIED;
      return res.json({
        ...cached,
        unverified,
        ...(unverified && {
          submission: {
            name: cached.name,
            brand: cached.brand,
            genericName: cached.genericName,
            energyKcal: cached.energyKcal,
            fat: cached.fat,
            saturatedFat: cached.saturatedFat,
            carbohydrates: cached.carbohydrates,
            sugars: cached.sugars,
            protein: cached.protein,
            salt: cached.salt,
            servingSize: cached.servingSize,
            ingredients: cached.ingredients,
          },
        }),
      });
    }

    // 2. Fetch from Open Food Facts (always VERIFIED — came from the curated OFF catalogue)
    const data = await fetchFromOpenFoodFacts(barcode);
    if (!data) {
      return res.status(404).json({ message: 'Product not found' });
    }

    // 3. Cache in DB and return
    const product = await prisma.product.create({ data });
    logger.info(`Product fetched and cached: ${barcode}`);
    res.json({ ...product, unverified: false });
  } catch (error) {
    logger.error(error);
    next(error);
  }
};

// POST /api/products/upload-image
export const uploadImage = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'image_required' });
    }

    const kind = req.body.kind as string;
    if (kind !== 'product' && kind !== 'label') {
      return res.status(400).json({ error: 'invalid_kind' });
    }

    // Detect format from magic bytes — don't trust the client Content-Type.
    const detected = await fileTypeFromBuffer(req.file.buffer);
    if (!detected || !SUPPORTED_MIME_TYPES.has(detected.mime)) {
      return res.status(415).json({ error: 'unsupported_format' });
    }

    // Plausibility / abuse gate. Runs on the in-memory buffer BEFORE the S3
    // upload, so a rejected image is never persisted (no orphan objects).
    const result = await checkImage(req.file.buffer, detected.mime, kind as ImageKind);

    if (result.verdict !== 'ok') {
      logger.info('image rejected by plausibility check', {
        kind,
        verdict: result.verdict,
        reason: result.reason,
        userId: req.user?.id,
      });

      if (result.verdict === 'abuse') {
        // Record a moderation flag against the uploader. Best-effort: never let a
        // logging-table write failure mask the rejection the user must still see.
        try {
          await prisma.userAbuseFlag.create({
            data: { userId: req.user!.id, reason: result.reason },
          });
        } catch (flagErr) {
          logger.error('failed to record UserAbuseFlag', { userId: req.user?.id, flagErr });
        }
      }

      return res.status(422).json({
        error: 'image_rejected',
        reason: REJECTION_MESSAGES[result.verdict],
      });
    }

    const url = await uploadImageToS3(req.file.buffer, kind as ImageKind);

    // Front-of-pack suggestions are only returned for product photos; the label
    // slot has no use for them (its data comes from the extract-label flow).
    if (kind === 'product') {
      return res.json({
        url,
        name: result.name,
        brand: result.brand,
        genericName: result.genericName,
      });
    }
    res.json({ url });
  } catch (err) {
    next(err);
  }
};

// POST /api/products
export const submitProduct = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const payload = validateProductSubmission(req.body);
    const userId = req.user!.id; // this ony works for auth paths with registered users

    const result = await createSubmittedProduct(payload, userId);
    res.status(result.action === 'created' ? 201 : 200).json(result.product);

  } catch (err) {
    if (err instanceof SubmissionValidationError) {
      return res.status(422).json({
        error: err.message,
        reason: err.message,
        field: err.field,
      });
    }
    if (err instanceof ProductPreviouslyRejectedError) {
      return res.status(409).json({ error: err.code });
    }
    if (
      err instanceof ProductAlreadyVerifiedError ||
      err instanceof ProductPendingByAnotherUserError
    ) {
      return res.status(409).json({ error: err.code });
    }
    next(err); // anything unexpected goes to the central errorHandler
  }
};

// POST /api/products/:barcode/verify
export const approveProduct = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const result = await castVote(req.params.barcode as string, req.user!.id, VerificationVote.APPROVE);
    res.json({ verifications: result.verifications });
  } catch (err) {
    if (err instanceof ProductNotFoundError) return res.status(404).json({ error: err.code });
    if (err instanceof ProductNotPendingError) return res.status(409).json({ error: err.code });
    if (err instanceof SelfVerificationError) return res.status(403).json({ error: err.code });
    next(err);
  }
};

// DELETE /api/products/:barcode/verify  (DELETE = REJECT vote, not retraction)
export const rejectProduct = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const result = await castVote(req.params.barcode as string, req.user!.id, VerificationVote.REJECT);
    res.json({ verifications: result.verifications });
  } catch (err) {
    if (err instanceof ProductNotFoundError) return res.status(404).json({ error: err.code });
    if (err instanceof ProductNotPendingError) return res.status(409).json({ error: err.code });
    if (err instanceof SelfVerificationError) return res.status(403).json({ error: err.code });
    next(err);
  }
};
