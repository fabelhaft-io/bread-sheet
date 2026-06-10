import { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';
import logger from '../logger.js';

// Initialize Supabase client
// Ensure these are in your server/.env file
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_PUBLISHABLE_DEFAULT_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

// Extend Express Request type to include user
export interface AuthRequest extends Request {
  user?: {
    id: string;
    email?: string;
    isAnonymous: boolean;
  };
}

export const requireAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({ error: 'Authorization header missing' });
    }

    // Expect format: "Bearer <token>"
    const token = authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Token missing' });
    }

    // Verify token with Supabase
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Attach user to request object
    req.user = {
      id: user.id,
      email: user.email,
      isAnonymous: user.is_anonymous !== false,
    };

    next();
  } catch (err) {
    logger.error('Auth middleware error', {
      errorName: (err as Error).name,
      errorMessage: (err as Error).message,
      stack: (err as Error).stack,
      path: req.originalUrl,
    });
    // Generic message — never echo the verifier internals back to the caller.
    res
      .status(500)
      .json({ error: 'Authentication failed. Please try again.' });
  }
};

export const requireRegistered = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (req.user.isAnonymous) {
    return res.status(403).json({ error: 'Registration required' });
  }
  next();
};