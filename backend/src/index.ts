import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { rateLimit, MemoryStore, ipKeyGenerator } from 'express-rate-limit';
import { timingSafeEqual } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import mealPlanRouter from './routes/mealPlan.js';
import { krogerAuthRouter, krogerApiRouter } from './routes/kroger.js';
import { accessRouter, TRUSTED_COOKIE } from './routes/access.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT ?? 3001;

// In production the frontend is served from the same origin, so CORS is only
// needed for local development where Vite runs on a different port.
const corsOrigin = process.env.CORS_ORIGIN ?? 'http://localhost:5173';
app.use(cors({ origin: corsOrigin }));
app.use(express.json());
// Passing a secret enables *signed* cookies (req.signedCookies) for the
// trusted-access cookie below, without changing how any existing unsigned
// cookie (e.g. the Kroger token) is read.
app.use(cookieParser(process.env.COOKIE_SIGNING_SECRET));

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

// Visiting the app at either /<code> (e.g. https://yourapp.com/your-code) or
// with ?access=<code> silently grants a long-lived, signed "trusted" cookie
// and redirects to the clean root — no login form, just a link to share with
// family/friends. Nothing else about the request is affected if the code is
// missing or wrong; it just falls through as normal (still subject to the
// strict rate limit below). Always redirects to "/" specifically rather than
// stripping the path in place — for the /<code> form, redirecting back to
// the same path would just re-trigger this same check forever.
const TRUSTED_COOKIE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

app.use((req, res, next) => {
  const expected = process.env.FULL_ACCESS_CODE;
  if (!expected) return next();

  const queryCode = req.query.access;
  const pathSegment = req.path.slice(1); // strip leading "/"

  const matchedViaQuery = typeof queryCode === 'string' && timingSafeEqualStrings(queryCode, expected);
  const matchedViaPath =
    pathSegment.length > 0 && !pathSegment.includes('/') && timingSafeEqualStrings(pathSegment, expected);

  if (matchedViaQuery || matchedViaPath) {
    res.cookie(TRUSTED_COOKIE, '1', {
      signed: true,
      httpOnly: true,
      secure: !!process.env.APP_URL,
      sameSite: 'lax',
      maxAge: TRUSTED_COOKIE_MAX_AGE_MS,
    });
    return res.redirect('/');
  }
  next();
});

const isProd = process.env.NODE_ENV === 'production';

// Explicit keyGenerator (rather than relying on the library default) so the
// usage-peek route below can compute the exact same key and read the exact
// same store — one source of truth instead of two systems tracking the same
// thing separately.
function mealPlanRateLimitKey(req: express.Request): string {
  return ipKeyGenerator(req.ip ?? '');
}

function mealPlanLimit(req: express.Request): number {
  return req.signedCookies?.[TRUSTED_COOKIE] ? 10 : isProd ? 2 : 1000;
}

const mealPlanStore = new MemoryStore();
const apiLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: mealPlanLimit,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'rate_limited' },
  store: mealPlanStore,
  keyGenerator: mealPlanRateLimitKey,
});

// Lets the frontend show "N of M requests used today" without spending one —
// a plain read of the same store/key the limiter itself uses, not a second
// tracking mechanism that could drift out of sync with it.
app.get('/api/meal-plan/usage', async (req, res) => {
  const key = mealPlanRateLimitKey(req);
  const info = await mealPlanStore.get(key);
  const limit = mealPlanLimit(req);
  const used = info?.totalHits ?? 0;
  res.json({
    used,
    limit,
    remaining: Math.max(0, limit - used),
    resetAt: info?.resetTime ? info.resetTime.getTime() : null,
  });
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
app.use('/api/access', accessRouter);

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
