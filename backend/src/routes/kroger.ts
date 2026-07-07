import { Router, Request, Response, NextFunction } from 'express';
import { rateLimit } from 'express-rate-limit';
import {
  getAuthUrl,
  exchangeCode,
  searchLocations,
  searchProductsForCart,
  addProductsToCart,
  type CartItem,
  type CartSelection,
  type UserToken,
} from '../services/krogerService.js';
import { arbitrateProductMatches, type ArbitrationItem } from '../services/productMatchService.js';
import { TRUSTED_COOKIE } from './access.js';

const FRONTEND_URL = process.env.APP_URL ?? 'http://localhost:5173';

// Claude-assisted product matching is Full Access only — requireTrustedAccess
// rejects anyone else outright (not just a lower cap, since the whole point
// is that this stays limited to family/friends with the access link). The
// limiter below only ever sees requests that already passed that check, so
// it's a flat cap rather than the two-tier free/trusted split used elsewhere.
const matchLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'rate_limited' },
});

function requireTrustedAccess(req: Request, res: Response, next: NextFunction) {
  if (!req.signedCookies?.[TRUSTED_COOKIE]) {
    return res.status(403).json({ error: 'Claude-assisted product matching requires Full Access.' });
  }
  next();
}

// The Kroger token lives in an httpOnly cookie on the user's browser rather
// than in server memory or a database — it survives dev-mode restarts,
// redeploys, and free-tier spin-downs with no extra infrastructure. `secure`
// mirrors the same "are we actually deployed" signal used for the OAuth
// redirect URI elsewhere in this app, since secure cookies are dropped by
// browsers over plain http:// (i.e. local dev).
const KROGER_TOKEN_COOKIE = 'sempai_kroger_token';
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function readTokenCookie(req: Request): UserToken | null {
  const raw = req.cookies?.[KROGER_TOKEN_COOKIE];
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UserToken;
  } catch {
    return null;
  }
}

function writeTokenCookie(res: Response, token: UserToken): void {
  res.cookie(KROGER_TOKEN_COOKIE, JSON.stringify(token), {
    httpOnly: true,
    secure: !!process.env.APP_URL,
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE_MS,
  });
}

function clearTokenCookie(res: Response): void {
  res.clearCookie(KROGER_TOKEN_COOKIE);
}

// ── OAuth routes (mounted at /auth/kroger) ────────────────────────────────────

export const krogerAuthRouter = Router();

krogerAuthRouter.get('/', (_req: Request, res: Response) => {
  res.redirect(getAuthUrl());
});

krogerAuthRouter.get('/callback', async (req: Request, res: Response) => {
  const { code, error } = req.query;

  if (error || !code || typeof code !== 'string') {
    return res.redirect(`${FRONTEND_URL}?kroger_error=1`);
  }

  try {
    const token = await exchangeCode(code);
    writeTokenCookie(res, token);
    res.redirect(`${FRONTEND_URL}?kroger_connected=1`);
  } catch {
    res.redirect(`${FRONTEND_URL}?kroger_error=1`);
  }
});

// ── API routes (mounted at /api/kroger) ───────────────────────────────────────

export const krogerApiRouter = Router();

krogerApiRouter.get('/status', (req: Request, res: Response) => {
  res.json({ connected: !!readTokenCookie(req) });
});

krogerApiRouter.post('/disconnect', (_req: Request, res: Response) => {
  clearTokenCookie(res);
  res.json({ success: true });
});

krogerApiRouter.get('/locations', async (req: Request, res: Response) => {
  const { zip } = req.query;
  if (!zip || typeof zip !== 'string') {
    return res.status(400).json({ error: 'ZIP code required' });
  }
  try {
    const locations = await searchLocations(zip);
    res.json({ success: true, locations });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to find locations';
    res.status(500).json({ error: message });
  }
});

// Search products for a list of shopping items — returns options per item
krogerApiRouter.post('/products', async (req: Request, res: Response) => {
  const { items, locationId } = req.body as { items: CartItem[]; locationId: string };

  if (!Array.isArray(items) || items.length === 0 || !locationId) {
    return res.status(400).json({ error: 'items array and locationId required' });
  }

  try {
    const results = await searchProductsForCart(items, locationId);
    res.json({ success: true, results });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Product search failed';
    res.status(500).json({ error: message });
  }
});

// Proxy Kroger product images — avoids CDN referer/CORS restrictions from localhost
krogerApiRouter.get('/image', async (req: Request, res: Response) => {
  const url = req.query.url as string;
  if (!url || !/^https:\/\/[^/]*kroger\.com\//.test(url)) {
    return res.status(400).end();
  }
  try {
    const r = await fetch(url);
    if (!r.ok) return res.status(r.status).end();
    res.set('Content-Type', r.headers.get('content-type') ?? 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch {
    res.status(502).end();
  }
});

// Add pre-selected products to cart
krogerApiRouter.post('/cart', async (req: Request, res: Response) => {
  const { selections } = req.body as { selections: CartSelection[] };

  if (!Array.isArray(selections) || selections.length === 0) {
    return res.status(400).json({ error: 'selections array required' });
  }

  const token = readTokenCookie(req);
  if (!token) {
    return res.status(401).json({ error: 'Not connected to Kroger. Please connect your account.' });
  }

  try {
    const { token: refreshedToken, ...result } = await addProductsToCart(selections, token);
    writeTokenCookie(res, refreshedToken);
    res.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to add to cart';
    const status = message.includes('session expired') ? 401 : 500;
    if (status === 401) clearTokenCookie(res);
    res.status(status).json({ error: message });
  }
});

// Ask Claude to arbitrate among Kroger candidates for a batch of ingredients
// at once (not one call per ingredient) — see productMatchService.ts for the
// cost-control choices (model, candidate cap, batching).
krogerApiRouter.post('/verify-matches', requireTrustedAccess, matchLimiter, async (req: Request, res: Response) => {
  const { items } = req.body as { items: ArbitrationItem[] };

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items array required' });
  }

  try {
    const results = await arbitrateProductMatches(items);
    res.json({ success: true, results });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Product verification failed';
    res.status(500).json({ error: message });
  }
});
