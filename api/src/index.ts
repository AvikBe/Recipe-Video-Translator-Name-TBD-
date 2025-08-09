import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import pino from 'pino';
import { router as apiRouter } from './routes/api.js';

const app = express();
const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'info' : 'debug' });
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info({ method: req.method, url: req.url, statusCode: res.statusCode, ms: Date.now() - start });
  });
  next();
});
app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));

const limiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
app.use(limiter);

app.use('/api', apiRouter);

app.get('/health', (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 4000;
app.listen(port, () => {
  logger.info({ port }, 'API listening');
});
