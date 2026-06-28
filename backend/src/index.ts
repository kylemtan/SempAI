import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import mealPlanRouter from './routes/mealPlan.js';
import { krogerAuthRouter, krogerApiRouter } from './routes/kroger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT ?? 3001;

// In production the frontend is served from the same origin, so CORS is only
// needed for local development where Vite runs on a different port.
const corsOrigin = process.env.CORS_ORIGIN ?? 'http://localhost:5173';
app.use(cors({ origin: corsOrigin }));
app.use(express.json());

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests — please wait 15 minutes before generating again.' },
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/image-proxy', async (req, res) => {
  const url = req.query.url as string;
  if (!url || !url.startsWith('https://')) { res.status(400).end(); return; }
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; recipe-aggregator/1.0)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) { res.status(r.status).end(); return; }
    res.set('Content-Type', r.headers.get('content-type') ?? 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch { res.status(502).end(); }
});

app.use('/api/meal-plan', apiLimiter, mealPlanRouter);
app.use('/auth/kroger', krogerAuthRouter);
app.use('/api/kroger', krogerApiRouter);

// Serve built frontend in production (backend/dist is two levels below frontend/dist)
const frontendDist = join(__dirname, '../../frontend/dist');
if (existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get('*', (_req, res) => {
    res.sendFile(join(frontendDist, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`SempAI backend running on http://localhost:${PORT}`);
});
