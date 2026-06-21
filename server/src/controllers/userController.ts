import { Response, NextFunction } from 'express';
import prisma from '../db.js';
import { AuthRequest } from '../middlewares/authMiddleware.js';
import logger from '../logger.js';

// POST /api/users/sync
// Upserts a User row using the Supabase user ID. Call this once after login.
export const syncUser = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id, email } = req.user!;

    // Supabase anonymous users carry an empty-string email (''), not undefined.
    // `email` is @unique, and Postgres treats '' as a real value (so a second
    // anonymous user collides), but allows multiple NULLs. Normalise any
    // falsy email to null so anonymous sessions don't violate the constraint.
    const normalizedEmail = email || null;

    const user = await prisma.user.upsert({
      where: { id },
      update: { email: normalizedEmail },
      create: { id, email: normalizedEmail },
    });

    logger.info(`User synced: ${user.id}`);
    res.status(200).json(user);
  } catch (error) {
    logger.error(error);
    next(error);
  }
};
