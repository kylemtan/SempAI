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
// The Kroger token is never held in server memory or on disk — it's handed
// back to the route layer, which stores it in an httpOnly cookie on the
// user's browser. That means it survives server restarts (dev-mode file
// watchers, redeploys, free-tier spin-downs) with no database to run.

export interface UserToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export function getAuthUrl(): string {
  const params = new URLSearchParams({
    scope: 'cart.basic:write',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
  });
  return `${KROGER_BASE}/connect/oauth2/authorize?${params}`;
}

export async function exchangeCode(code: string): Promise<UserToken> {
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

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
}

// Returns a token guaranteed valid for immediate use, refreshing via Kroger
// first if the one passed in has expired. Callers must persist the returned
// token back to the cookie — a refresh rotates the access token (and
// sometimes the refresh token too).
export async function ensureValidUserToken(token: UserToken): Promise<UserToken> {
  if (Date.now() < token.expiresAt) return token;

  const res = await fetch(`${KROGER_BASE}/connect/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth()}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: token.refreshToken,
    }).toString(),
  });

  if (!res.ok) {
    throw new Error('Kroger session expired. Please reconnect your account.');
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? token.refreshToken,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
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
  looksLikeIngredient: boolean;
}

export interface ProductSearchResult {
  displayName: string;
  krogerSearchTerm: string;
  options: ProductOption[];
}

// Strip prep descriptors, parentheticals, and "or X" alternatives so
// "Dried Rice Stick Noodles (Banh Pho, 1/8-Inch Wide)" → "Rice Stick Noodles"
// "Thinly Sliced Beef Ribeye Or Sirloin" → "Beef Ribeye"
const PREP_RE = /\b(fresh|dried|cooked|frozen|canned|raw|whole|sliced|thinly\s+sliced|thickly\s+sliced|chopped|minced|diced|shredded|crusty|skin[\s-]on|skin[\s-]off|bone[\s-]in|bone[\s-]less|trimmed|peeled|halved|quartered|toasted|roasted|sprigs?|stalks?|bunches?|leaves?)\b/gi;

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

// Recipe-speak vs. retail-speak naming differences — mirrors the alias table
// used for match scoring on the frontend (ShoppingListModal.tsx), duplicated
// here since the two projects don't share code. Used to retry the *search
// itself* when the original term returns nothing — e.g. Kroger's catalog may
// index "green onion" but return zero results for "scallions", which no
// amount of re-scoring existing results can fix. Not exhaustive — extend as
// new mismatches turn up (keep both copies in sync).
const INGREDIENT_ALIASES: [RegExp, string][] = [
  [/\bscallions?\b/g, 'green onion'],
  [/\bspring onions?\b/g, 'green onion'],
  [/\bcilantro\b/g, 'coriander'],
  [/\bgarbanzo(?:\s+beans?)?s?\b/g, 'chickpea'],
  [/\barugula\b/g, 'rocket'],
  [/\beggplants?\b/g, 'aubergine'],
  [/\bzucchinis?\b/g, 'courgette'],
  [/\bshrimps?\b/g, 'prawn'],
  [/\bjalape[nñ]os?\b/g, 'jalapeno'],
  [/\b(?:powdered|icing)\s+sugar\b/g, 'confectioners sugar'],
  [/\ball-purpose flour\b/g, 'plain flour'],
  [/\bheavy cream\b/g, 'heavy whipping cream'],
  [/\bstring beans?\b/g, 'green bean'],
  [/\bsnow peas?\b/g, 'mangetout'],
  [/\bromaine\b/g, 'cos lettuce'],
  [/\bchil(?:i|e)s?\b/g, 'chili'],
];

function aliasSearchTerm(term: string): string {
  let t = term.toLowerCase();
  for (const [pattern, canonical] of INGREDIENT_ALIASES) {
    t = t.replace(pattern, canonical);
  }
  return t;
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

// Kroger's own search relevance ranking sometimes surfaces off-category matches
// for ingredient searches — e.g. "mint leaves" returning breath-mint gum, since
// both share the word "mint". Category is a much stronger signal than text
// overlap here: a recipe ingredient is never going to be gum, toothpaste, or
// pet food, regardless of how well the product name matches.
const NON_FOOD_CATEGORY_KEYWORDS = [
  'candy', 'gum', 'mints',
  'personal care', 'beauty', 'cosmetic', 'hair care', 'oral care', 'skin care', 'deodorant',
  'household', 'cleaning', 'laundry', 'paper product', 'plastic wrap', 'foil',
  'pet ', 'baby', 'diaper',
  'office', 'school supplies', 'automotive', 'electronics',
  'toy', 'greeting card', 'floral', 'tobacco',
  'vitamin', 'supplement', 'medicine', 'first aid',
];

function isLikelyNonFood(categories: string[]): boolean {
  const joined = categories.join(' ').toLowerCase();
  return NON_FOOD_CATEGORY_KEYWORDS.some((kw) => joined.includes(kw));
}

// Departments that plausibly sell raw/whole cooking ingredients. This is a
// *soft* signal, not a hard filter — a product outside all of these isn't
// excluded (sometimes it's genuinely the only thing a store carries), it's
// just marked as not looking like an ingredient so the frontend can weigh it
// against the alternatives and flag it for the user to double-check instead
// of presenting it as a confirmed match.
//
// This is deliberately an allowlist of the departments ingredients actually
// live in, rather than a denylist of wrong departments — snacks, beverages,
// candy, and cereal all routinely borrow flavor names from real ingredients
// ("Lemongrass Sparkling Water", "Green Onion Potato Chips", "Jasmine Flavored
// Rice"), and there's no way to enumerate every product category that might
// do this next. Listing the departments that ARE ingredients is a much
// smaller, more stable list than listing every department that ISN'T.
const INGREDIENT_DEPARTMENT_KEYWORDS = [
  'produce', 'fruit', 'vegetable', 'herb',
  'meat', 'seafood', 'poultry', 'deli', 'tofu',
  'dairy', 'egg', 'cheese',
  'bakery', 'bread',
  'pasta', 'rice', 'grain', 'noodle', 'bean', 'legume',
  'canned', 'jarred', 'broth', 'stock', 'pickle',
  'condiment', 'sauce', 'dressing',
  'spice', 'season',
  'baking', 'flour', 'sugar',
  'frozen fruit', 'frozen vegetable',
  'international', 'ethnic', 'asian', 'hispanic', 'mexican', 'indian',
  'oil', 'vinegar', 'nut', 'seed',
];

function looksLikeIngredientDepartment(categories: string[]): boolean {
  const joined = categories.join(' ').toLowerCase();
  return INGREDIENT_DEPARTMENT_KEYWORDS.some((kw) => joined.includes(kw));
}

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

  return (data.data ?? [])
    .filter((p) => !isLikelyNonFood(p.categories ?? []))
    .map((p) => {
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
        looksLikeIngredient: looksLikeIngredientDepartment(p.categories ?? []),
      };
    });
}

async function findProductOptions(term: string, locationId: string, limit = 50): Promise<ProductOption[]> {
  const simplified = simplifySearchTerm(term);

  const r1 = await queryProducts(simplified, locationId, limit);
  if (r1.length > 0) return r1;

  // Retry with retail-speak naming before falling back to a blunter
  // truncation — an alias substitution preserves more of the original
  // meaning than just chopping the term down to its last couple of words.
  const aliased = aliasSearchTerm(simplified);
  if (aliased !== simplified.toLowerCase()) {
    const r2 = await queryProducts(aliased, locationId, limit);
    if (r2.length > 0) return r2;
  }

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
  quantity: number;
}

export async function addProductsToCart(
  selections: CartSelection[],
  userToken: UserToken
): Promise<{ added: string[]; token: UserToken }> {
  if (selections.length === 0) return { added: [], token: userToken };

  const token = await ensureValidUserToken(userToken);
  const cartRes = await fetch(`${KROGER_BASE}/cart/add`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: selections.map(({ productId, quantity }) => ({ quantity: quantity || 1, upc: productId })),
    }),
  });

  if (!cartRes.ok) {
    const err = await cartRes.text();
    throw new Error(`Failed to add items to cart: ${err}`);
  }

  return { added: selections.map((s) => s.displayName), token };
}
