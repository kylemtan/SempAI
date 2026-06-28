import { tavily } from '@tavily/core';

const client = tavily({ apiKey: process.env.TAVILY_API_KEY ?? '' });

export interface RecipeSlot {
  day: string;
  date: string;
  mealType: string;
  recipeName: string;
  cuisineHint: string;
  sourceSite: string;
}

export interface EnrichedRecipe extends RecipeSlot {
  sourceUrl: string | null;
  imageUrl: string | null;
  content: string | null;
}

// ── Tavily search ─────────────────────────────────────────────────────────────

async function searchRecipeUrl(recipeName: string, sourceSite: string): Promise<string | null> {
  try {
    const res = await client.search(`${recipeName} recipe`, {
      includeDomains: [sourceSite],
      maxResults: 1,
      searchDepth: 'basic',
    });
    return res.results[0]?.url ?? null;
  } catch {
    return null;
  }
}

// ── JSON-LD extraction (primary) ──────────────────────────────────────────────
// Most recipe sites embed Schema.org Recipe structured data in JSON-LD blocks —
// the same data Google uses for recipe cards. It's pure signal: ingredients,
// steps, and nutrition with no blog prose.

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; recipe-aggregator/1.0)' },
      signal: AbortSignal.timeout(8000),
    });
    return res.ok ? res.text() : null;
  } catch {
    return null;
  }
}

function extractJsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try { blocks.push(JSON.parse(m[1])); } catch { /* skip malformed block */ }
  }
  return blocks;
}

function findRecipeSchema(blocks: unknown[]): Record<string, unknown> | null {
  for (const block of blocks) {
    const b = block as Record<string, unknown>;
    if (b['@type'] === 'Recipe') return b;
    // @graph pattern (very common — BreadcrumbList + Recipe in one block)
    if (Array.isArray(b['@graph'])) {
      const r = (b['@graph'] as Record<string, unknown>[]).find((x) => x['@type'] === 'Recipe');
      if (r) return r;
    }
    // Top-level array
    if (Array.isArray(block)) {
      const r = (block as Record<string, unknown>[]).find((x) => x['@type'] === 'Recipe');
      if (r) return r;
    }
  }
  return null;
}

function extractImageUrl(schema: Record<string, unknown>): string | null {
  const img = schema.image;
  if (!img) return null;
  if (typeof img === 'string') return img;

  function urlFromObj(obj: unknown): string | null {
    if (!obj || typeof obj !== 'object') return null;
    const o = obj as Record<string, unknown>;
    if (typeof o.url === 'string' && o.url) return o.url;
    if (typeof o.contentUrl === 'string' && o.contentUrl) return o.contentUrl;
    return null;
  }

  if (Array.isArray(img)) {
    for (const item of img) {
      if (typeof item === 'string' && item) return item;
      const u = urlFromObj(item);
      if (u) return u;
    }
  }
  return urlFromObj(img);
}

function parseIsoDuration(iso: unknown): string {
  if (typeof iso !== 'string') return '';
  const m = iso.match(/P(?:.*?T)?(?:(\d+)H)?(?:(\d+)M)?/i);
  if (!m) return iso;
  const h = parseInt(m[1] ?? '0');
  const min = parseInt(m[2] ?? '0');
  if (h && min) return `${h}h ${min}min`;
  if (h) return `${h}h`;
  if (min) return `${min}min`;
  return iso;
}

function flattenInstructions(steps: unknown[]): string[] {
  return steps.flatMap((step) => {
    if (typeof step === 'string') return [step];
    const s = step as Record<string, unknown>;
    // HowToSection contains itemListElement
    if (s['@type'] === 'HowToSection' && Array.isArray(s.itemListElement)) {
      return flattenInstructions(s.itemListElement as unknown[]);
    }
    if (typeof s.text === 'string') return [s.text];
    return [];
  });
}

function formatRecipeSchema(schema: Record<string, unknown>): string {
  const lines: string[] = [];

  if (schema.name) lines.push(`Name: ${schema.name}`);
  if (schema.prepTime) lines.push(`Prep: ${parseIsoDuration(schema.prepTime)}`);
  if (schema.cookTime) lines.push(`Cook: ${parseIsoDuration(schema.cookTime)}`);
  const yld = schema.recipeYield;
  if (yld) lines.push(`Yield: ${Array.isArray(yld) ? yld[0] : yld}`);

  const ingredients = schema.recipeIngredient;
  if (Array.isArray(ingredients) && ingredients.length > 0) {
    lines.push('\nIngredients:');
    (ingredients as string[]).forEach((i) => lines.push(`- ${i}`));
  }

  const instructions = schema.recipeInstructions;
  if (Array.isArray(instructions) && instructions.length > 0) {
    lines.push('\nInstructions:');
    flattenInstructions(instructions).forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  }

  const nutrition = schema.nutrition as Record<string, unknown> | undefined;
  if (nutrition) {
    const nLines: string[] = [];
    if (nutrition.calories)            nLines.push(`Calories: ${nutrition.calories}`);
    if (nutrition.carbohydrateContent) nLines.push(`Carbs: ${nutrition.carbohydrateContent}`);
    if (nutrition.fatContent)          nLines.push(`Fat: ${nutrition.fatContent}`);
    if (nutrition.proteinContent)      nLines.push(`Protein: ${nutrition.proteinContent}`);
    if (nutrition.fiberContent)        nLines.push(`Fiber: ${nutrition.fiberContent}`);
    if (nutrition.sodiumContent)       nLines.push(`Sodium: ${nutrition.sodiumContent}`);
    if (nutrition.sugarContent)        nLines.push(`Sugar: ${nutrition.sugarContent}`);
    if (nLines.length > 0) {
      lines.push('\nNutrition (per serving):');
      nLines.forEach((l) => lines.push(l));
    }
  }

  return lines.join('\n');
}

// ── Tavily Extract fallback (for sites without JSON-LD or behind WAFs) ────────
// Scan the raw text for the ingredient section and window from there; fall
// back to the last portion of the text since recipe cards are often at the end.

const TAVILY_WINDOW = 4000;

async function tavilyExtractFallback(url: string): Promise<string | null> {
  try {
    const res = await client.extract([url]);
    const raw = res.results[0]?.rawContent ?? '';
    if (!raw) return null;
    if (raw.length <= TAVILY_WINDOW) return raw;

    const lower = raw.toLowerCase();
    const idx = lower.indexOf('ingredient');
    if (idx !== -1) {
      const start = Math.max(0, idx - 150);
      return raw.slice(start, start + TAVILY_WINDOW);
    }
    return raw.slice(-TAVILY_WINDOW);
  } catch {
    return null;
  }
}

// ── Multi-source image extraction ────────────────────────────────────────────

function isLogoOrIcon(url: string): boolean {
  const u = url.toLowerCase();
  return ['logo', 'icon', 'favicon', 'placeholder', 'default', 'noimage', 'no-image', 'banner']
    .some((kw) => u.includes(kw));
}

function metaContent(html: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = html.match(re);
    const url = m?.[1];
    if (url && url.startsWith('http')) return url;
  }
  return null;
}

function pickBestImage(candidates: (string | null)[]): string | null {
  const valid = candidates.filter((u): u is string => !!u && u.startsWith('http'));
  return valid.find((u) => !isLogoOrIcon(u)) ?? valid[0] ?? null;
}

function extractHtmlImages(html: string, schema: Record<string, unknown> | null): string | null {
  const candidates: (string | null)[] = [];

  // 1. JSON-LD schema image — most reliable when present
  if (schema) candidates.push(extractImageUrl(schema));

  // 2. og:image
  candidates.push(metaContent(html, [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
  ]));

  // 3. twitter:image (common on Asian recipe blogs)
  candidates.push(metaContent(html, [
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
    /<meta[^>]+property=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
  ]));

  // 4. Microdata itemprop="image" (used by many Asian/indie food sites)
  candidates.push(metaContent(html, [
    /itemprop=["']image["'][^>]+(?:content|src)=["']([^"']+)["']/i,
    /(?:content|src)=["']([^"']+)["'][^>]+itemprop=["']image["']/i,
  ]));

  return pickBestImage(candidates);
}

// ── Main extraction: JSON-LD → Tavily fallback ────────────────────────────────

async function extractRecipeContent(url: string): Promise<{ content: string | null; imageUrl: string | null }> {
  const html = await fetchHtml(url);
  let imageUrl: string | null = null;
  if (html) {
    const schema = findRecipeSchema(extractJsonLdBlocks(html));
    imageUrl = extractHtmlImages(html, schema ?? null);
    if (schema) {
      const formatted = formatRecipeSchema(schema);
      if (formatted.length > 80) {
        return { content: formatted, imageUrl };
      }
    }
  }
  return { content: await tavilyExtractFallback(url), imageUrl };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function enrichRecipes(
  slots: RecipeSlot[],
  onProgress?: (msg: string) => void
): Promise<EnrichedRecipe[]> {
  // Wave 1: search all recipe URLs in parallel
  let searched = 0;
  const total = slots.length;
  const urls = await Promise.all(
    slots.map(async (s) => {
      try {
        const url = await searchRecipeUrl(s.recipeName, s.sourceSite);
        onProgress?.(`(${++searched}/${total})`);
        return url;
      } catch {
        onProgress?.(`(${++searched}/${total})`);
        return null;
      }
    })
  );

  onProgress?.('Retrieving recipe details…');

  // Wave 2: extract content + image from all found URLs in parallel
  const extracted = await Promise.all(
    urls.map((url) =>
      url
        ? extractRecipeContent(url).catch(() => ({ content: null, imageUrl: null }))
        : Promise.resolve({ content: null, imageUrl: null })
    )
  );

  return slots.map((slot, i) => ({
    ...slot,
    sourceUrl: urls[i],
    imageUrl: extracted[i].imageUrl,
    content: extracted[i].content,
  }));
}
