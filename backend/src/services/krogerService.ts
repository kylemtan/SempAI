const KROGER_BASE = 'https://api.kroger.com/v1';
const REDIRECT_URI = process.env.APP_URL
  ? `${process.env.APP_URL.replace(/\/$/, '').replace(/^http:\/\//, 'https://')}/auth/kroger/callback`
  : 'http://localhost:3001/auth/kroger/callback';

console.log('[Kroger] redirect_uri:', REDIRECT_URI);

const CLIENT_ID = process.env.KROGER_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.KROGER_CLIENT_SECRET ?? '';

function basicAuth(): string {
  return Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
}

// ── Concurrency limiter ────────────────────────────────────────────────────────
// Prevents thundering-herd bursts against the Kroger API.

async function pLimit<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

// ── Client Credentials (product search + locations) ───────────────────────────
// Single-flight: if a token fetch is already in progress every concurrent caller
// awaits the same promise instead of firing its own OAuth request.

let clientToken: { value: string; expiresAt: number } | null = null;
let clientTokenFlight: Promise<string> | null = null;

async function getClientToken(): Promise<string> {
  if (clientToken && Date.now() < clientToken.expiresAt) return clientToken.value;

  if (!clientTokenFlight) {
    clientTokenFlight = (async () => {
      try {
        const res = await fetch(`${KROGER_BASE}/connect/oauth2/token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${basicAuth()}`,
          },
          body: 'grant_type=client_credentials&scope=product.compact',
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`Kroger auth failed (${res.status}): ${body}`);
        }
        const data = (await res.json()) as { access_token: string; expires_in: number };
        clientToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
        return clientToken.value;
      } finally {
        clientTokenFlight = null;
      }
    })();
  }

  return clientTokenFlight;
}

// ── User OAuth (cart) ─────────────────────────────────────────────────────────

interface UserToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

let userToken: UserToken | null = null;

export function getAuthUrl(): string {
  const params = new URLSearchParams({
    scope: 'cart.basic:write',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
  });
  return `${KROGER_BASE}/connect/oauth2/authorize?${params}`;
}

export async function exchangeCode(code: string): Promise<void> {
  const res = await fetch(`${KROGER_BASE}/connect/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth()}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }).toString(),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Kroger token exchange failed: ${body}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  userToken = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
}

async function getUserToken(): Promise<string> {
  if (!userToken) throw new Error('Not connected to Kroger. Please connect your account.');

  if (Date.now() >= userToken.expiresAt) {
    const res = await fetch(`${KROGER_BASE}/connect/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basicAuth()}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: userToken.refreshToken,
      }).toString(),
    });

    if (!res.ok) {
      userToken = null;
      throw new Error('Kroger session expired. Please reconnect your account.');
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    userToken = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? userToken.refreshToken,
      expiresAt: Date.now() + (data.expires_in - 60) * 1000,
    };
  }

  return userToken.accessToken;
}

export function isUserConnected(): boolean {
  return userToken !== null;
}

export function disconnectUser(): void {
  userToken = null;
}

// ── Locations ─────────────────────────────────────────────────────────────────

export interface KrogerLocation {
  locationId: string;
  name: string;
  chain: string;
  address: string;
}

export async function searchLocations(zip: string): Promise<KrogerLocation[]> {
  const token = await getClientToken();
  const params = new URLSearchParams({ 'filter.zipCode.near': zip, 'filter.limit': '5' });
  const res = await fetch(`${KROGER_BASE}/locations?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) throw new Error(`Failed to fetch locations: ${res.status}`);

  const data = (await res.json()) as {
    data: {
      locationId: string;
      name: string;
      chain: string;
      address: { addressLine1: string; city: string; state: string };
    }[];
  };

  return (data.data ?? []).map((loc) => ({
    locationId: loc.locationId,
    name: loc.name,
    chain: loc.chain,
    address: `${loc.address.addressLine1}, ${loc.address.city}, ${loc.address.state}`,
  }));
}

// ── Products ──────────────────────────────────────────────────────────────────

export interface ProductOption {
  productId: string;
  brand: string;
  description: string;
  size: string;
  soldBy: string;
  regularPrice: number | null;
  promoPrice: number | null;
  stockLevel: string | null; // "HIGH" | "LOW" | "TEMPORARILY_OUT_OF_STOCK"
  imageUrl: string | null;
  categories: string[];
}

export interface ProductSearchResult {
  displayName: string;
  krogerSearchTerm: string;
  options: ProductOption[];
}

// Strip prep descriptors, parentheticals, and "or X" alternatives so
// "Dried Rice Stick Noodles (Banh Pho, 1/8-Inch Wide)" → "Rice Stick Noodles"
// "Thinly Sliced Beef Ribeye Or Sirloin" → "Beef Ribeye"
const PREP_RE = /\b(fresh|dried|cooked|frozen|canned|raw|whole|sliced|thinly\s+sliced|thickly\s+sliced|chopped|minced|diced|shredded|crusty|skin[\s-]on|skin[\s-]off|bone[\s-]in|bone[\s-]less|trimmed|peeled|halved|quartered|toasted|roasted|sprigs?|stalks?|bunches?)\b/gi;

function simplifySearchTerm(raw: string): string {
  const s = raw
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/,.*$/, '')
    .replace(/\s+or\s+.*$/i, '')
    .replace(PREP_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length >= 2 ? s : raw;
}

function coreSearchTerm(simplified: string): string {
  const words = simplified.split(/\s+/).filter(Boolean);
  return words.slice(-Math.min(2, words.length)).join(' ');
}

type KrogerProductRaw = {
  productId: string;
  brand?: string;
  description: string;
  categories?: string[];
  items?: {
    size?: string;
    soldBy?: string;
    price?: { regular?: number; promo?: number };
    inventory?: { stockLevel?: string };
  }[];
  images?: {
    perspective: string;
    featured?: boolean;
    sizes: { id: string; url: string }[];
  }[];
};

async function queryProducts(term: string, locationId: string, limit: number): Promise<ProductOption[]> {
  const token = await getClientToken();
  const params = new URLSearchParams({
    'filter.term': term,
    'filter.locationId': locationId,
    'filter.fulfillment': 'ais',
    'filter.limit': String(limit),
  });

  const res = await fetch(`${KROGER_BASE}/products?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    // Surface auth/rate-limit errors so the caller can abort the whole batch
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      const body = await res.text().catch(() => '');
      throw new Error(`Kroger API error ${res.status} for "${term}": ${body}`);
    }
    return [];
  }
  const data = (await res.json()) as { data: KrogerProductRaw[] };

  return (data.data ?? []).map((p) => {
    const item = p.items?.[0];
    const frontImg = p.images?.find((img) => img.perspective === 'front') ?? p.images?.[0];
    const imageUrl =
      frontImg?.sizes.find((s) => s.id === 'small')?.url ??
      frontImg?.sizes.find((s) => s.id === 'thumbnail')?.url ??
      frontImg?.sizes[0]?.url ??
      null;

    return {
      productId: p.productId,
      brand: p.brand ?? '',
      description: p.description,
      size: item?.size ?? '',
      soldBy: item?.soldBy ?? '',
      regularPrice: item?.price?.regular ?? null,
      promoPrice: item?.price?.promo ?? null,
      stockLevel: item?.inventory?.stockLevel ?? null,
      imageUrl,
      categories: p.categories ?? [],
    };
  });
}

async function findProductOptions(term: string, locationId: string, limit = 50): Promise<ProductOption[]> {
  const simplified = simplifySearchTerm(term);

  const r1 = await queryProducts(simplified, locationId, limit);
  if (r1.length > 0) return r1;

  const core = coreSearchTerm(simplified);
  if (core !== simplified) return queryProducts(core, locationId, limit);

  return [];
}

const SEARCH_CONCURRENCY = 5;

export async function searchProductsForCart(
  items: CartItem[],
  locationId: string
): Promise<ProductSearchResult[]> {
  return pLimit(
    items.map((item) => async () => ({
      displayName: item.displayName,
      krogerSearchTerm: item.krogerSearchTerm,
      options: await findProductOptions(item.krogerSearchTerm, locationId),
    })),
    SEARCH_CONCURRENCY
  );
}

// ── Cart ──────────────────────────────────────────────────────────────────────

export interface CartItem {
  krogerSearchTerm: string;
  displayName: string;
}

export interface CartSelection {
  productId: string;
  displayName: string;
}

export async function addProductsToCart(selections: CartSelection[]): Promise<{ added: string[] }> {
  if (selections.length === 0) return { added: [] };

  const token = await getUserToken();
  const cartRes = await fetch(`${KROGER_BASE}/cart/add`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: selections.map(({ productId }) => ({ quantity: 1, upc: productId })),
    }),
  });

  if (!cartRes.ok) {
    const err = await cartRes.text();
    throw new Error(`Failed to add items to cart: ${err}`);
  }

  return { added: selections.map((s) => s.displayName) };
}
