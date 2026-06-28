const BASE = '';

export interface KrogerLocation {
  locationId: string;
  name: string;
  chain: string;
  address: string;
}

export async function searchKrogerLocations(zip: string): Promise<KrogerLocation[]> {
  const res = await fetch(`${BASE}/api/kroger/locations?zip=${encodeURIComponent(zip)}`);
  const json = (await res.json()) as { success: boolean; locations: KrogerLocation[]; error?: string };
  if (!json.success) throw new Error(json.error ?? 'Failed to find locations');
  return json.locations;
}

export interface CartPayloadItem {
  krogerSearchTerm: string;
  displayName: string;
}

export interface ProductOption {
  productId: string;
  brand: string;
  description: string;
  size: string;
  soldBy: string;
  regularPrice: number | null;
  promoPrice: number | null;
  stockLevel: string | null;
  imageUrl: string | null;
  categories: string[];
}

export interface ProductSearchResult {
  displayName: string;
  krogerSearchTerm: string;
  options: ProductOption[];
}

export async function searchKrogerProducts(
  items: CartPayloadItem[],
  locationId: string
): Promise<ProductSearchResult[]> {
  const res = await fetch(`${BASE}/api/kroger/products`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, locationId }),
  });
  const json = (await res.json()) as { success: boolean; results: ProductSearchResult[]; error?: string };
  if (!json.success) throw new Error(json.error ?? 'Product search failed');
  return json.results;
}

export interface CartSelection {
  productId: string;
  displayName: string;
}

export async function addToKrogerCart(selections: CartSelection[]): Promise<{ added: string[] }> {
  const res = await fetch(`${BASE}/api/kroger/cart`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selections }),
  });
  const json = (await res.json()) as { success: boolean; added: string[]; error?: string };
  if (!json.success) throw new Error(json.error ?? 'Failed to add to cart');
  return { added: json.added };
}
