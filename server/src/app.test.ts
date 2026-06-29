import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

// Keep the real rate limiter (the subject under test). Stub out db so importing
// the route tree doesn't spin up a real Prisma client, and stub auth so its
// top-level Supabase client isn't constructed at import time.
vi.mock('./db.js', () => ({ default: {} }));
vi.mock('./middlewares/authMiddleware.js', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireRegistered: (_req: any, _res: any, next: any) => next(),
}));

import app from './app.js';

describe('trust proxy / express-rate-limit behind the ALB', () => {
  it('trusts a single proxy hop so req.ip resolves to the forwarded client', () => {
    // 1 = trust exactly the Fargate ALB. `false` would make every client share
    // the ALB's IP as their rate-limit key; `true` would trust spoofed headers.
    expect(app.get('trust proxy')).toBe(1);
  });

  it('does not throw ERR_ERL_UNEXPECTED_X_FORWARDED_FOR when X-Forwarded-For is present', async () => {
    // The api limiter runs on every /api/* request before routing, so an
    // unmatched path still exercises its IP key generator. With trust proxy
    // unset this combination throws and surfaces as a 500; with the fix the
    // request simply falls through to a 404.
    const res = await request(app)
      .get('/api/__ratelimit_probe__')
      .set('X-Forwarded-For', '203.0.113.7');

    expect(res.status).toBe(404);
  });
});