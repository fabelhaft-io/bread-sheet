import express from 'express';
import cors from 'cors';
import { errorHandler } from './middlewares/errorHandler.js';
import { apiLimiter } from './middlewares/rateLimit.js';
import userRoutes from './routes/userRoutes.js';
import productRoutes from './routes/productRoutes.js';
import ratingRoutes from './routes/ratingRoutes.js';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:8081').split(',');

const app = express();

app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json());

// Rate limiting
app.use('/api', apiLimiter);

// Health check
app.get('/', (_req, res) => {
  res.send('Bread Sheet API is running');
});

// Routes
app.use('/api/users', userRoutes);
app.use('/api/products', productRoutes);
app.use('/api/ratings', ratingRoutes);

// Global error handler (must be last)
app.use(errorHandler);

export default app;
