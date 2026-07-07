import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Haiku, not Sonnet — this is a short classification task over a handful of
// product descriptions per ingredient, not recipe generation. Cheaper and
// fast enough that batching several ingredients into one call still returns
// quickly.
const MODEL = 'claude-haiku-4-5-20251001';

// Bounds the prompt regardless of how many raw Kroger results a search
// returned — callers should already be capping to in-stock-preferred
// candidates before this, but this is the hard ceiling.
const MAX_CANDIDATES_PER_ITEM = 8;

export interface ArbitrationCandidate {
  productId: string;
  brand: string;
  description: string;
  size: string;
  regularPrice: number | null;
  promoPrice: number | null;
  stockLevel: string | null;
}

export interface ArbitrationItem {
  key: string;
  ingredientName: string;
  searchTerm: string;
  neededQuantity: string;
  recipeContext?: string;
  candidates: ArbitrationCandidate[];
}

export interface ArbitrationResult {
  key: string;
  productId: string | null;
  confident?: boolean;
  reason?: string;
}

function parseJSON(text: string): unknown {
  let t = text.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  }
  const firstBracket = t.indexOf('[');
  if (firstBracket > 0) t = t.slice(firstBracket);
  const lastBracket = t.lastIndexOf(']');
  if (lastBracket !== -1 && lastBracket < t.length - 1) t = t.slice(0, lastBracket + 1);
  try {
    return JSON.parse(t);
  } catch {
    throw new SyntaxError(`JSON parse failed. Raw response:\n\n${t}`);
  }
}

const SYSTEM = `You are helping choose the best real grocery product for recipe ingredients, from actual Kroger search results.

For each ingredient, pick the ONE candidate that is genuinely the right item for cooking — right ingredient, right form (fresh vs. dried, whole vs. ground, etc.), not a snack/drink/novelty product that merely shares a flavor name.

HARD RULE — regional/national varieties: if the ingredient names a specific regional or national variety (e.g. "Thai chili", "Japanese eggplant", "Mexican crema", "Chinese five-spice"), a candidate only counts as a real match if its own description also carries that same regional qualifier. A candidate for the generic base ingredient without that qualifier (e.g. a plain "hot chili pepper" for "Thai chili") is NOT a match, even though it's the same broad category and even though it's a substitute a home cook might reasonably use. Do not make that substitution decision on the shopper's behalf — return null instead and let them decide. Only skip this rule if the ingredient itself has no regional/national qualifier to begin with.

Among candidates that ARE genuinely correct, prefer the lower price. Ignore candidates marked OUT OF STOCK unless every candidate is out of stock.

If NONE of the candidates are a reasonable match for the ingredient, return "productId": null for that ingredient instead of forcing a bad pick — this is expected and fine when the store just doesn't carry it.

When you DO pick a candidate, also set "confident" honestly: false if you picked the closest reasonable option but aren't fully sure it's right (e.g. ambiguous between very similar candidates, unclear which size/brand actually fits, or it's a borderline case rather than a clean match) — true if you're genuinely sure. Don't default to true just because you picked something; a shaky pick with confident: false is more useful than false certainty.

Return ONLY a raw JSON array, no prose, no markdown:
[{ "key": "<the ingredient's key, copied exactly>", "productId": "<chosen id>" | null, "confident": true | false, "reason": "one short phrase, especially when null or unconfident" }]`;

function formatCandidate(c: ArbitrationCandidate): string {
  const price = c.promoPrice ?? c.regularPrice;
  const priceStr = price != null ? `$${price.toFixed(2)}` : 'price n/a';
  const stock = c.stockLevel === 'TEMPORARILY_OUT_OF_STOCK' ? ' | OUT OF STOCK' : '';
  return `  - id: ${c.productId} | ${c.brand ? c.brand + ' ' : ''}${c.description} | ${c.size || 'size n/a'} | ${priceStr}${stock}`;
}

function buildPrompt(items: ArbitrationItem[]): string {
  return items.map((item) => {
    const candidates = item.candidates.slice(0, MAX_CANDIDATES_PER_ITEM);
    const contextLine = item.recipeContext ? `\n${item.recipeContext}` : '';
    return `Ingredient key: "${item.key}"\nNeeded: ${item.ingredientName} (quantity: ${item.neededQuantity || 'n/a'})\nSearched Kroger for: "${item.searchTerm}"${contextLine}\nCandidates:\n${candidates.map(formatCandidate).join('\n')}`;
  }).join('\n\n');
}

export async function arbitrateProductMatches(items: ArbitrationItem[]): Promise<ArbitrationResult[]> {
  if (items.length === 0) return [];

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 150 + items.length * 60,
    system: SYSTEM,
    messages: [{ role: 'user', content: buildPrompt(items) }],
  });

  const raw = msg.content[0];
  if (raw.type !== 'text') throw new Error('Unexpected response from product matching');
  return parseJSON(raw.text) as ArbitrationResult[];
}
