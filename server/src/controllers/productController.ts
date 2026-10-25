import { Response, NextFunction } from 'express';
import { fileTypeFromBuffer } from 'file-type';
import prisma from '../db.js';
import { Prisma } from '../generated/prisma_client/client.js';
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
import { visibleProductWhere } from '../services/productVisibility.js';
import { serializeProduct } from '../services/productSerializer.js';
import { uploadImageToS3, type ImageKind } from '../services/imageService.js';
import { checkImage, type Verdict } from '../services/imagePlausibilityService.js';
import logger from '../logger.js';
import { AuthRequest } from '../middlewares/authMiddleware.js';
import {
  SubmissionValidationError,
  validateProductSubmission,
} from '../validators/productSubmissionValidator.js';
import { ProductKind, ProductStatus, VerificationVote } from '../generated/prisma_client/enums.js';

const SUPPORTED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/webp',
  'image/png',
  'image/gif',
  'image/tiff',
  'image/avif',
]);

// GTINs are EAN-8, UPC-A (12 digits), or EAN-13 — all numeric.
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

// GET /api/products/gtin/:gtin — the only way to resolve a GTIN to a product.
// On a cache miss, fetches from Open Food Facts and creates the Product +
// PackagedProduct rows in one transaction (ADR 0006).
export const getProductByGtin = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const gtin = req.params.gtin as string;

    if (!BARCODE_RE.test(gtin)) {
      return res.status(400).json({ message: 'Invalid barcode format' });
    }

    // 1. Check local cache first
    const cached = await prisma.packagedProduct.findUnique({
      where: { gtin },
      include: { product: true },
    });
    if (cached) {
      // REJECTED products are invisible to every caller — peer review has
      // already thrown this data out, and the resubmission path (P5-003) runs
      // through the "not found → add it" flow. PENDING_REVIEW products, by
      // contrast, are visible to everyone since P5-007.
      if (cached.product.status === ProductStatus.REJECTED) {
        return res.status(404).json({ message: 'Product not found' });
      }

      logger.info(`Product cache hit: ${gtin}`);
      return res.json(
        serializeProduct({ ...cached.product, packaged: cached }, req.user),
      );
    }

    // 2. Fetch from Open Food Facts (always VERIFIED — came from the curated OFF catalogue)
    const data = await fetchFromOpenFoodFacts(gtin);
    if (!data) {
      return res.status(404).json({ message: 'Product not found' });
    }

    // 3. Cache in DB (Product + PackagedProduct, one transaction) and return
    let createdProduct;
    let createdPackaged;
    try {
      const result = await prisma.$transaction(async (tx) => {
        const product = await tx.product.create({
          data: {
            kind: ProductKind.PACKAGED,
            name: data.name,
            brand: data.brand,
            image: data.image,
            description: data.description,
            status: ProductStatus.VERIFIED,
          },
        });
        const packaged = await tx.packagedProduct.create({
          data: { productId: product.id, gtin },
        });
        return { product, packaged };
      });
      createdProduct = result.product;
      createdPackaged = result.packaged;
      logger.info(`Product fetched and cached: ${gtin}`);
    } catch (err) {
      // Two concurrent first-scans of the same new GTIN are normal, not an
      // error — re-read what the other request created instead of 409ing.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const reread = await prisma.packagedProduct.findUnique({
          where: { gtin },
          include: { product: true },
        });
        if (!reread) throw err;
        createdProduct = reread.product;
        createdPackaged = reread;
      } else {
        throw err;
      }
    }

    res.json(
      serializeProduct({ ...createdProduct, packaged: createdPackaged }, req.user),
    );
  } catch (error) {
    logger.error(error);
    next(error);
  }
};

// GET /api/products/:productId
export const getProductById = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const productId = req.params.productId as string;

    const product = await prisma.product.findFirst({
      where: { id: productId, ...visibleProductWhere(req.user) },
      include: { packaged: true },
    });
    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    logger.info(`Product cache hit: ${productId}`);
    res.json(serializeProduct(product, req.user));
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

    const imageKey = await uploadImageToS3(req.file.buffer, kind as ImageKind);

    // Front-of-pack suggestions are only returned for product photos; the label
    // slot has no use for them (its data comes from the extract-label flow).
    if (kind === 'product') {
      return res.json({
        imageKey,
        name: result.name,
        brand: result.brand,
        genericName: result.genericName,
      });
    }
    res.json({ imageKey });
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

// POST /api/products/:productId/verify
export const approveProduct = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const result = await castVote(req.params.productId as string, req.user!.id, VerificationVote.APPROVE);
    res.json({ verifications: result.verifications });
  } catch (err) {
    if (err instanceof ProductNotFoundError) return res.status(404).json({ error: err.code });
    if (err instanceof ProductNotPendingError) return res.status(409).json({ error: err.code });
    if (err instanceof SelfVerificationError) return res.status(403).json({ error: err.code });
    next(err);
  }
};

// DELETE /api/products/:productId/verify  (DELETE = REJECT vote, not retraction)
export const rejectProduct = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const result = await castVote(req.params.productId as string, req.user!.id, VerificationVote.REJECT);
    res.json({ verifications: result.verifications });
  } catch (err) {
    if (err instanceof ProductNotFoundError) return res.status(404).json({ error: err.code });
    if (err instanceof ProductNotPendingError) return res.status(409).json({ error: err.code });
    if (err instanceof SelfVerificationError) return res.status(403).json({ error: err.code });
    next(err);
  }
};
