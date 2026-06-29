import express from 'express';
import cors from 'cors';
import { errorHandler } from './middlewares/errorHandler.js';
import { apiLimiter } from './middlewares/rateLimit.js';
import { requestLogger } from './middlewares/requestLogger.js';
import userRoutes from './routes/userRoutes.js';
import productRoutes from './routes/productRoutes.js';
import ratingRoutes from './routes/ratingRoutes.js';
import config from './configs/config.js';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:8081').split(',');

const app = express();

// Behind the Fargate ALB, the client IP arrives in X-Forwarded-For. Trust the
// single ALB hop so req.ip resolves to the real client and express-rate-limit
// keys per-client (not per-ALB). Must stay 1 unless another proxy (e.g.
// CloudFront) is added in front of the ALB.
app.set('trust proxy', 1);

app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
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
app.use('/api/ratings', ratingRoutes);

// Global error handler (must be last)
app.use(errorHandler);

export default app;
