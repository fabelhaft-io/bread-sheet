import { Router } from 'express';
import { requireAuth, requireRegistered } from '../middlewares/authMiddleware.js';
import { apiLimiter } from '../middlewares/rateLimit.js';
import { createCustomProductHandler } from '../controllers/customProductController.js';

const router = Router();

// POST /api/custom-products — TICKET-P6-007. Registered users only; an
// anonymous session 403s before the handler runs.
router.post('/', requireAuth, apiLimiter, requireRegistered, createCustomProductHandler);

export default router;
