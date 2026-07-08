// Shared ingredient-name normalization, used both to merge shopping-list rows
// that mean the same thing (buildShoppingList) and to match a shopping-list row
// against a pantry entry (pantryNames/isPantry checks). Keeping one canonical
// function means the two can never disagree on what "the same ingredient" is.

// Quality/grade descriptors that don't change what you'd actually buy — safe to
// drop when computing the merge key. Deliberately conservative: words that change
// the product (unsalted/salted, red/white wine vinegar, raw honey, etc.) must NOT
// go here, since that would silently merge genuinely different ingredients. Longer
// phrases must precede shorter ones they contain (e.g. "extra virgin" before "virgin").
const DROPPABLE_QUALIFIERS = [
  'extra virgin',
  'virgin',
  'cold pressed',
];

function baseClean(name: string): string {
  let n = name.trim();
  n = n.replace(/\s*\([^)]*\)/g, '');
  n = n.replace(/,.*$/, '');
  n = n.replace(
    /\s+(for\s+(garnish|serving|topping)|to\s+(garnish|taste|serve|finish)|optional|as\s+needed|to\s+finish)\s*$/i,
    ''
  );
  n = n.replace(
    /^(freshly\s+|roughly\s+|finely\s+|thinly\s+|coarsely\s+|lightly\s+)?(fresh\s+)?(chopped|minced|diced|sliced|grated|shredded|peeled|cubed|torn|crumbled|crushed|trimmed|halved|quartered)\s+/i,
    ''
  );
  return n.trim().toLowerCase();
}

// Recipe-speak vs. retail-speak naming differences — the same real ingredient is
// often described differently in a recipe than it's labeled at the store. Shared
// between the shopping-list merge key below and the Kroger product-match scorer,
// so "scallion" and "green onion" are treated as the same ingredient in both
// places. Not exhaustive — extend as new mismatches turn up.
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

export function normalizeIngredientAliases(text: string): string {
  let t = text.toLowerCase();
  for (const [pattern, canonical] of INGREDIENT_ALIASES) {
    t = t.replace(pattern, canonical);
  }
  return t;
}

// Naive singular-only normalization for a single word (no qualifier-dropping) —
// used where callers tokenize text into individual words, e.g. Kroger
// product-description word-overlap scoring, where stripping a standalone
// "virgin" would corrupt matching rather than help it.
export function singularize(n: string): string {
  if (n.endsWith('ies') && n.length > 3) return n.slice(0, -3) + 'y';
  if (n.endsWith('oes') || n.endsWith('shes') || n.endsWith('ches') || n.endsWith('xes')) return n.slice(0, -2);
  if (n.endsWith('s') && !n.endsWith('ss')) return n.slice(0, -1);
  return n;
}

// Cleaned but not over-normalized — keeps qualifiers/plurality, used to build a
// user-facing display name (title-cased at the call site).
export function cleanIngredientName(name: string): string {
  return baseClean(name);
}

// Aggressively normalized merge key — synonym-insensitive (recipe-speak vs.
// retail-speak), hyphen-insensitive, quality-qualifier-insensitive, and
// singular/plural-insensitive. Two ingredient names collapse to the same
// shopping-list row (and the same pantry-match) iff this key matches.
export function canonicalIngredientKey(name: string): string {
  let n = baseClean(name);
  // Alias matching must run before hyphens are normalized away — some patterns
  // (e.g. "all-purpose flour") rely on the literal hyphen.
  n = normalizeIngredientAliases(n);
  n = n.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  for (const q of DROPPABLE_QUALIFIERS) {
    n = n.replace(new RegExp(`\\b${q}\\b\\s*`, 'g'), '').trim();
  }
  return singularize(n);
}
