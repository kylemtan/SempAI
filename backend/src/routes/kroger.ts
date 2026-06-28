import { Router, Request, Response } from 'express';
import {
  getAuthUrl,
  exchangeCode,
  isUserConnected,
  disconnectUser,
  searchLocations,
  searchProductsForCart,
  addProductsToCart,
  type CartItem,
  type CartSelection,
} from '../services/krogerService.js';

const FRONTEND_URL = process.env.APP_URL ?? 'http://localhost:5173';

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
    await exchangeCode(code);
    res.redirect(`${FRONTEND_URL}?kroger_connected=1`);
  } catch {
    res.redirect(`${FRONTEND_URL}?kroger_error=1`);
  }
});

// ── API routes (mounted at /api/kroger) ───────────────────────────────────────

export const krogerApiRouter = Router();

krogerApiRouter.get('/status', (_req: Request, res: Response) => {
  res.json({ connected: isUserConnected() });
});

krogerApiRouter.post('/disconnect', (_req: Request, res: Response) => {
  disconnectUser();
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

  try {
    const result = await addProductsToCart(selections);
    res.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to add to cart';
    const status =
      message.includes('Not connected') || message.includes('session expired') ? 401 : 500;
    res.status(status).json({ error: message });
  }
});
