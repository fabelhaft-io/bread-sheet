import express from 'express';
import cors from 'cors';
import { errorHandler } from './middlewares/errorHandler.js';
import { apiLimiter } from './middlewares/rateLimit.js';
import { requestLogger } from './middlewares/requestLogger.js';
import { requireOriginSecret } from './middlewares/requireOriginSecret.js';
import userRoutes from './routes/userRoutes.js';
import productRoutes from './routes/productRoutes.js';
import customProductRoutes from './routes/customProductRoutes.js';
import ratingRoutes from './routes/ratingRoutes.js';
import config from './configs/config.js';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:8081').split(',');

const app = express();

// Two proxy hops in front of Express when it forwards to the API Gateway custom origin,
// and API Gateway/the VPC link contribute the second (VPC link itself is just ENIs and
// adds no hop of its own — this "1" is the same one ADR 0003 already relied on when the ALB
// was removed). `req.ip` must resolve to the real client, not CloudFront's
// edge IP, or every client behind one edge location shares an
// express-rate-limit bucket. `2`, not `true`: forged X-Forwarded-For headers
// still can't be used to dodge limits. Bump only if another proxy is added.
app.set('trust proxy', 2);

// CORS first, ahead of every gate below it. `cors` only *adds* response
// headers, so it grants no access on its own — but a rejection that lacks
// Access-Control-Allow-Origin is unreadable to a browser: fetch rejects with a
// bare TypeError, lib/api.ts maps that to NetworkError, and the app renders
// OFFLINE_MESSAGE.
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));

// 403s any /api/* request that didn't arrive through the
// CloudFront distribution in front of the API — see the middleware for what
// that actually buys, given the API Gateway custom domain stays publicly
// resolvable. Runs before anything else touches the request body.
app.use('/api', requireOriginSecret);

app.use(express.json());

// Request logging — emits a structured line per request including method,
// path, status, duration, and (when auth has run) the userId.
app.use(requestLogger);

// Rate limiting
app.use('/api', apiLimiter);

// Health check
app.get('/', (_req, res) => {
  res.send('Bread Sheet API is running');
});

// Auth callback — Supabase redirects here after email verification.
// We bounce the user into the app via the configured deep link scheme so that
// exchangeCodeForSession() in the app can complete the PKCE flow.
app.get('/auth/callback', (req, res) => {
  const params = new URLSearchParams(req.query as Record<string, string>);
  const deepLink = `${config.appDeepLinkScheme}:///auth/callback?${params.toString()}`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Opening BreadSheet…</title>
  <script>window.location.href = ${JSON.stringify(deepLink)};</script>
</head>
<body>Opening BreadSheet… If the app does not open automatically, make sure Expo Go is running.</body>
</html>`);
});

// Routes
app.use('/api/users', userRoutes);
app.use('/api/products', productRoutes);
app.use('/api/custom-products', customProductRoutes);
app.use('/api/ratings', ratingRoutes);

// Global error handler (must be last)
app.use(errorHandler);

export default app;
