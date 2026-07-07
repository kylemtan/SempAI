import Anthropic from '@anthropic-ai/sdk';
import { enrichRecipes, type RecipeSlot, type EnrichedRecipe } from './tavilyService.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface SlotToGenerate {
  day: string;
  date: string;
  mealType: string;
}

interface ExistingMeal {
  mealType: string;
  name: string;
  macros: { calories: number; carbohydrates: number; protein: number; fats: number; sugar: number };
}

interface DayContext {
  day: string;
  meals: ExistingMeal[];
}

export interface MealPlanRequest {
  cuisines: string[];
  equipment: string[];
  macros: { maxCalories: number; maxCarbs: number; maxFats: number; minFiber: number; minProtein: number };
  dietary: {
    maxSodium: number;
    allergens: string[];
    isVegetarian: boolean;
    isVegan: boolean;
    isHalal: boolean;
    isKosher: boolean;
    maxSugar: number;
  };
  maxPrepTime: number;
  maxCookTime: number;
  mealsPerDay: number;
  leftovers: string;
  otherPreferences: string;
  blacklist: string[];
  startDate?: string;
  numDays?: number;
  pinnedRecipes?: { name: string; cuisineHint: string; mealType: string }[];
  slotsToGenerate?: SlotToGenerate[];
  existingDayMeals?: DayContext[];
  searchMode?: 'web' | 'training';
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function getMealTypes(mealsPerDay: number): string[] {
  const plans: Record<number, string[]> = {
    1: ['dinner'],
    2: ['breakfast', 'dinner'],
    3: ['breakfast', 'lunch', 'dinner'],
    4: ['breakfast', 'lunch', 'snack', 'dinner'],
    5: ['breakfast', 'morning snack', 'lunch', 'afternoon snack', 'dinner'],
    6: ['breakfast', 'morning snack', 'lunch', 'afternoon snack', 'dinner', 'evening snack'],
  };
  return plans[mealsPerDay] ?? plans[3];
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function getPlanDates(startDate?: string, numDays?: number): { weekOf: string; days: { day: string; date: string }[] } {
  const count = Math.min(Math.max(numDays ?? 7, 1), 7);
  let start: Date;
  if (startDate) {
    const [y, m, d] = startDate.split('-').map(Number);
    start = new Date(y, m - 1, d);
  } else {
    start = new Date();
    start.setHours(0, 0, 0, 0);
  }
  const days = Array.from({ length: count }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return { day: DAY_NAMES[d.getDay()], date: d.toISOString().split('T')[0] };
  });
  return { weekOf: days[0].date, days };
}

function preferenceSummary(req: MealPlanRequest): string {
  const dietaryFlags = [
    req.dietary.isVegan && 'Vegan',
    req.dietary.isVegetarian && !req.dietary.isVegan && 'Vegetarian',
    req.dietary.isHalal && 'Halal',
    req.dietary.isKosher && 'Kosher',
  ].filter(Boolean);

  return [
    `Cuisine: ${req.cuisines.length ? req.cuisines.join(', ') : 'Any'}`,
    `Equipment: ${req.equipment.length ? req.equipment.join(', ') : 'Standard kitchen'}`,
    `Daily calorie limit: ${req.macros.maxCalories} kcal`,
    `Daily protein: ≥${req.macros.minProtein}g | Daily carbs: ≤${req.macros.maxCarbs}g | Daily fat: ≤${req.macros.maxFats}g | Daily fiber: ≥${req.macros.minFiber}g`,
    `Daily sodium: ≤${req.dietary.maxSodium}mg | Daily sugar: ≤${req.dietary.maxSugar}g`,
    dietaryFlags.length ? `Diet: ${dietaryFlags.join(', ')}` : '',
    `Max prep time per recipe: ${req.maxPrepTime} min | Max cook time per recipe: ${req.maxCookTime} min`,
    req.leftovers ? `Ingredients to use up (include each in 1–2 recipes across the week, not in every meal): ${req.leftovers}` : '',
    req.otherPreferences ? `Other preferences: ${req.otherPreferences}` : '',
    req.blacklist.length ? `Do NOT use these recent recipes: ${req.blacklist.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

function parseJSON(text: string): unknown {
  let t = text.trim();

  // Strip markdown code fences
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  }

  // If there's prose before the JSON, find the first structural character
  const firstBracket = t.indexOf('[');
  const firstBrace   = t.indexOf('{');
  const jsonStart =
    firstBracket === -1 ? firstBrace :
    firstBrace   === -1 ? firstBracket :
    Math.min(firstBracket, firstBrace);

  if (jsonStart > 0) t = t.slice(jsonStart);

  // Trim any trailing prose after the closing bracket/brace
  const lastBracket = t.lastIndexOf(']');
  const lastBrace   = t.lastIndexOf('}');
  const jsonEnd = Math.max(lastBracket, lastBrace);
  if (jsonEnd !== -1 && jsonEnd < t.length - 1) t = t.slice(0, jsonEnd + 1);

  try {
    return JSON.parse(t);
  } catch {
    throw new SyntaxError(`JSON parse failed. Raw response:\n\n${t}`);
  }
}

// ── Per-meal macro budget ─────────────────────────────────────────────────────

// Relative weights reflecting how large each meal typically is
const MEAL_WEIGHTS: Record<string, number> = {
  breakfast: 3.0,
  'morning snack': 1.0,
  lunch: 3.5,
  snack: 1.5,
  'afternoon snack': 1.0,
  dinner: 4.0,
  'evening snack': 1.0,
};

function perMealTargetsSection(req: MealPlanRequest): string {
  // When regen has day context, the remaining-budget block already covers this
  if (req.existingDayMeals?.length) return '';

  const mealTypes = req.slotsToGenerate
    ? [...new Set(req.slotsToGenerate.map((s) => s.mealType))]
    : getMealTypes(req.mealsPerDay);

  const totalWeight = mealTypes.reduce((sum, mt) => sum + (MEAL_WEIGHTS[mt] ?? 2.0), 0);

  const lines = mealTypes.map((mt) => {
    const ratio = (MEAL_WEIGHTS[mt] ?? 2.0) / totalWeight;
    const cal     = Math.round(req.macros.maxCalories  * ratio);
    const protein = Math.round(req.macros.minProtein   * ratio);
    const carb    = Math.round(req.macros.maxCarbs     * ratio);
    const fat     = Math.round(req.macros.maxFats      * ratio);
    const sug     = Math.round(req.dietary.maxSugar    * ratio);
    return `  ${mt.padEnd(18)}: ≤${cal} kcal | ≥${protein}g protein | ≤${carb}g carbs | ≤${fat}g fat | ≤${sug}g sugar`;
  });

  return `\nPER-MEAL MACRO LIMITS (each individual recipe must stay within these):\n${lines.join('\n')}`;
}

// ── Allergen guard ────────────────────────────────────────────────────────────

const ALLERGEN_TRAPS: Record<string, string> = {
  Peanuts:      'NO Kung Pao Chicken, Pad Thai, Satay, Dan Dan Noodles, or any peanut sauce dish',
  'Tree Nuts':  'NO cashew chicken, walnut dishes, pine-nut dishes',
  Soy:          'NO tofu, edamame, soy sauce, teriyaki — nearly all Chinese/Asian recipes use soy sauce, so choose carefully',
  Shellfish:    'NO shrimp, crab, lobster, scallops, oysters, prawns',
  Fish:         'NO fish sauce (extremely common in Thai cooking), anchovy, fish fillets',
  Gluten:       'NO regular soy sauce (contains wheat), wheat noodles, dumpling/gyoza wrappers',
  Dairy:        'NO butter, cream, cheese, milk-based sauces',
  Eggs:         'NO fried rice with egg, egg drop soup, egg noodles, egg-based dishes',
};

function allergenGuardSection(allergens: string[]): string {
  if (!allergens.length) return '';

  const lines = allergens.map((a) => {
    const trap = ALLERGEN_TRAPS[a];
    return trap ? `  • ${a}: ${trap}` : `  • ${a}: avoid all dishes that commonly contain ${a.toLowerCase()}`;
  });

  return `\nALLERGEN CHECK — before finalising each recipe name, verify it does not contain:\n${lines.join('\n')}`;
}

// ── Day context for regen ─────────────────────────────────────────────────────

function dayContextSection(req: MealPlanRequest): string {
  if (!req.existingDayMeals?.length) return '';

  const blocks = req.existingDayMeals.map(({ day, meals }) => {
    const mealLines = meals.map((m) =>
      `    - ${m.mealType}: "${m.name}" → ${m.macros.calories} kcal | ${m.macros.protein}g protein | ${m.macros.sugar}g sugar | ${m.macros.fats}g fat | ${m.macros.carbohydrates}g carbs`
    ).join('\n');

    const usedCal     = meals.reduce((s, m) => s + m.macros.calories, 0);
    const usedProtein = meals.reduce((s, m) => s + m.macros.protein, 0);
    const usedSug     = meals.reduce((s, m) => s + m.macros.sugar, 0);
    const usedFat     = meals.reduce((s, m) => s + m.macros.fats, 0);
    const usedCarb    = meals.reduce((s, m) => s + m.macros.carbohydrates, 0);

    const remCal     = Math.max(0, req.macros.maxCalories - usedCal);
    const remProtein = Math.max(0, req.macros.minProtein  - usedProtein);
    const remSug     = Math.max(0, req.dietary.maxSugar   - usedSug);
    const remFat     = Math.max(0, req.macros.maxFats     - usedFat);
    const remCarb    = Math.max(0, req.macros.maxCarbs    - usedCarb);

    return [
      `  ${day} — meals already set:`,
      mealLines,
      `  Remaining daily budget for the new meal(s): ≤${remCal} kcal | ≥${remProtein}g protein still needed | ≤${remSug}g sugar | ≤${remFat}g fat | ≤${remCarb}g carbs`,
    ].join('\n');
  });

  return `\nDAY CONTEXT — the new recipe(s) must fit within the remaining daily budget below:\n${blocks.join('\n\n')}`;
}

// ── Shared prompts ────────────────────────────────────────────────────────────

const PLANNING_SYSTEM = `You are a meal planning assistant. Return ONLY a valid JSON array of meal slots — no prose, no markdown, just raw JSON starting with [ and ending with ].

Each object must have exactly these fields:
{
  "day": "Monday",
  "date": "YYYY-MM-DD",
  "mealType": "breakfast" | "lunch" | "dinner" | "snack" | "morning snack" | "afternoon snack" | "evening snack",
  "recipeName": "Exact Recipe Name",
  "cuisineHint": "Cuisine Type",
  "sourceSite": "the most authoritative website for this specific recipe, e.g. seriouseats.com, allrecipes.com, bbcgoodfood.com, foodnetwork.com, epicurious.com, bonappetit.com, nytcooking.com"
}

Before finalising each recipe name:
1. Check it fits within the per-meal macro limits provided.
2. Check it respects the prep/cook time limits.
3. Check it does not contain any excluded allergens — reason through the ingredient list in your head.
4. Check it can be made with only the listed equipment.
5. If "Ingredients to use up" were specified, each such ingredient should appear in at most 1–2 recipes across the entire week — do not repeat them in every meal of the same type.
Only then add it to your output.`;

const RECIPE_SCHEMA = `{
  "id": "kebab-case-unique-id",
  "name": "Recipe Name",
  "cuisine": "Cuisine Type",
  "prepTime": 10,
  "cookTime": 20,
  "servings": 2,
  "macros": { "calories": 450, "carbohydrates": 52, "protein": 28, "fats": 14, "fiber": 6, "sodium": 820, "sugar": 8 },
  "dietaryTags": ["vegetarian"],
  "equipment": ["oven"],
  "ingredients": [{ "name": "canonical ingredient name — NO prep descriptors (write 'cilantro' not 'fresh chopped cilantro', 'garlic' not 'minced garlic', 'onion' not 'diced yellow onion') — save prep details for steps", "quantity": 1, "unit": "cup", "krogerSearchTerm": "grocery term" }],
  "steps": ["Step 1.", "Step 2."],
  "notes": "Optional tip.",
  "sourceSite": "allrecipes.com"
}`;

const SYNTHESIS_RULES = `CRITICAL RULES:
1. Return ONLY raw valid JSON. No prose, no markdown, no code fences.
2. Use the real retrieved content for ingredients, steps, and notes. Do not contradict real content.
3. Set "sourceSite" to just the domain from the Source URL (e.g. "seriouseats.com"). If no URL was found, use the suggested site.
4. Estimate macros accurately from real ingredient quantities.
5. Strictly respect all dietary restrictions, allergen exclusions, per-meal macro limits (including minimum protein targets), and the remaining day budget where provided.
6. Never include any blacklisted recipe.`;

function buildRecipeBlocks(enriched: EnrichedRecipe[]): string {
  return enriched.map((r) => {
    const header = `=== ${r.day.toUpperCase()} — ${r.mealType.toUpperCase()}: ${r.recipeName} ===`;
    const urlLine = r.sourceUrl
      ? `Source URL: ${r.sourceUrl}`
      : `Source URL: not found — use ${r.sourceSite} as sourceSite`;
    const contentBlock = r.content
      ? `Content:\n${r.content}`
      : `[No web content retrieved — use training knowledge for this recipe]`;
    return `${header}\n${urlLine}\n${contentBlock}`;
  }).join('\n\n');
}

function buildPlanningMessage(req: MealPlanRequest): string {
  const { days } = getPlanDates(req.startDate, req.numDays);
  const slots = req.slotsToGenerate
    ? req.slotsToGenerate.map((s) => `${s.day} ${s.date} — ${s.mealType}`)
    : days.flatMap(({ day, date }) =>
        getMealTypes(req.mealsPerDay).map((mealType) => `${day} ${date} — ${mealType}`)
      );

  const pinnedSection = req.pinnedRecipes?.length
    ? `\nREQUIRED RECIPES TO INCLUDE (assign these to appropriate slots):\n${req.pinnedRecipes.map((p) => `- "${p.name}" (${p.cuisineHint}) as ${p.mealType}`).join('\n')}`
    : '';

  const dayCount = req.slotsToGenerate ? 'partial' : `${days.length}-day`;
  return `Plan a ${dayCount} meal schedule.

MEAL SLOTS TO FILL:
${slots.join('\n')}
${pinnedSection}

USER PREFERENCES:
${preferenceSummary(req)}
${perMealTargetsSection(req)}
${allergenGuardSection(req.dietary.allergens)}
${dayContextSection(req)}`;
}

// ── Full week generation — parallel day synthesis ─────────────────────────────

const DAY_SYNTHESIS_SYSTEM = `You are a professional chef and meal planner. You have been given real recipe content retrieved from cooking websites.

${SYNTHESIS_RULES}

Return a JSON ARRAY of meal objects for the day — one entry per meal slot:
[
  { "mealType": "breakfast", "recipe": ${RECIPE_SCHEMA} }
]`;

function buildDaySynthesisMessage(
  req: MealPlanRequest,
  day: { day: string; date: string },
  enriched: EnrichedRecipe[]
): string {
  return `Generate recipe JSON for ${day.day} (${day.date}).

USER PREFERENCES:
${preferenceSummary(req)}
${perMealTargetsSection(req)}
${allergenGuardSection(req.dietary.allergens)}

REAL RECIPE DATA RETRIEVED FROM THE WEB:
${buildRecipeBlocks(enriched)}`;
}

async function synthesizeDay(
  req: MealPlanRequest,
  day: { day: string; date: string },
  enriched: EnrichedRecipe[]
): Promise<{ mealType: string; recipe: unknown }[]> {
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 6000,
    system: DAY_SYNTHESIS_SYSTEM,
    messages: [{ role: 'user', content: buildDaySynthesisMessage(req, day, enriched) }],
  });
  const raw = msg.content[0];
  if (raw.type !== 'text') throw new Error(`Unexpected response synthesizing ${day.day}`);
  return parseJSON(raw.text) as { mealType: string; recipe: unknown }[];
}

// ── Shopping list — built programmatically from recipe ingredients ─────────────
// Claude already returned structured ingredients in each day synthesis (each
// ingredient has krogerSearchTerm, quantity, and unit). Aggregating in code is
// instant, free, and never truncates.

interface IngredientRow {
  name: string;
  quantity: number;
  unit: string;
  krogerSearchTerm: string;
}

function toTitleCase(str: string): string {
  return str.replace(/\b\w/g, (c) => c.toUpperCase());
}

// Strips prep/usage descriptors so "fresh chopped cilantro" and "cilantro (garnish)"
// both key to "cilantro" for deduplication purposes.
function normalizeIngredientName(name: string): string {
  let n = name.trim();
  n = n.replace(/\s*\([^)]*\)/g, '');          // remove parentheticals
  n = n.replace(/,.*$/, '');                    // remove everything after a comma
  n = n.replace(
    /\s+(for\s+(garnish|serving|topping)|to\s+(garnish|taste|serve|finish)|optional|as\s+needed|to\s+finish)\s*$/i,
    ''
  );
  // strip leading pure-prep adjectives (not "ground beef", "dried oregano" — those stay)
  n = n.replace(
    /^(freshly\s+|roughly\s+|finely\s+|thinly\s+|coarsely\s+|lightly\s+)?(fresh\s+)?(chopped|minced|diced|sliced|grated|shredded|peeled|cubed|torn|crumbled|crushed|trimmed|halved|quartered)\s+/i,
    ''
  );
  return n.trim().toLowerCase();
}

function buildShoppingList(
  mealPlan: { day: string; meals: { mealType: string; recipe: unknown }[] }[]
): unknown[] {
  const map = new Map<string, {
    krogerSearchTerm: string;
    displayName: string;
    byUnit: Map<string, number>;
    usedIn: Set<string>;
  }>();

  for (const day of mealPlan) {
    for (const meal of day.meals) {
      const recipe = meal.recipe as Record<string, unknown>;
      const recipeName = recipe.name as string;
      const ingredients = (recipe.ingredients as IngredientRow[]) ?? [];

      for (const ing of ingredients) {
        const key = normalizeIngredientName(ing.name);
        if (!map.has(key)) {
          map.set(key, {
            krogerSearchTerm: ing.krogerSearchTerm,
            displayName: toTitleCase(key),
            byUnit: new Map(),
            usedIn: new Set(),
          });
        }
        const entry = map.get(key)!;
        const unit = (ing.unit ?? '').toLowerCase().trim();
        entry.byUnit.set(unit, (entry.byUnit.get(unit) ?? 0) + (ing.quantity ?? 0));
        entry.usedIn.add(recipeName);
      }
    }
  }

  return Array.from(map.values()).map((entry) => {
    const qty = Array.from(entry.byUnit.entries())
      .map(([unit, amount]) => {
        const rounded = Math.round(amount * 100) / 100;
        const num = rounded % 1 === 0 ? rounded.toString() : rounded.toString();
        return unit ? `${num} ${unit}` : num;
      })
      .join(' + ');
    return {
      krogerSearchTerm: entry.krogerSearchTerm,
      displayName: entry.displayName,
      estimatedQuantity: qty,
      usedIn: Array.from(entry.usedIn),
    };
  });
}

export async function generateMealPlan(
  req: MealPlanRequest,
  onProgress: (msg: string) => void = () => {}
): Promise<unknown> {
  if (req.searchMode === 'training') return generateMealPlanFromTraining(req, onProgress);

  // Phase 1 — Plan which recipes to use
  onProgress('Choosing recipes based on your preferences…');
  const planMsg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    system: PLANNING_SYSTEM,
    messages: [{ role: 'user', content: buildPlanningMessage(req) }],
  });

  const planRaw = planMsg.content[0];
  if (planRaw.type !== 'text') throw new Error('Unexpected response from planning phase');
  const slots = parseJSON(planRaw.text) as RecipeSlot[];
  onProgress(`Selected ${slots.length} recipes — searching the web…`);

  // Phase 2 — Parallel Tavily search + extract for every recipe
  const enriched = await enrichRecipes(slots, onProgress);

  // Phase 3 — Synthesise all days in parallel (each day is an independent call)
  onProgress('Writing your meal plan…');
  const { weekOf, days } = getPlanDates(req.startDate, req.numDays);

  let daysWritten = 0;
  const mealPlanDays = await Promise.all(
    days.map(async (d) => {
      const dayEnriched = enriched.filter((r) => r.day === d.day && r.date === d.date);
      const meals = await synthesizeDay(req, d, dayEnriched);
      onProgress(`(${++daysWritten}/${days.length})`);
      // Stitch the actual source URL from Tavily onto each synthesized recipe
      const mealsWithUrl = meals.map((meal) => {
        const src = dayEnriched.find((r) => r.mealType === meal.mealType);
        return {
          ...meal,
          recipe: {
            ...(meal.recipe as Record<string, unknown>),
            sourceUrl: src?.sourceUrl ?? null,
            imageUrl: src?.imageUrl ?? null,
          },
        };
      });
      return { day: d.day, date: d.date, meals: mealsWithUrl };
    })
  );

  const shoppingList = buildShoppingList(mealPlanDays);

  return { weekOf, mealPlan: mealPlanDays, shoppingList };
}

// ── Selective regeneration ────────────────────────────────────────────────────

const REGEN_SYNTHESIS_SYSTEM = `You are a professional chef and meal planner. You have been given real recipe content retrieved from cooking websites.

${SYNTHESIS_RULES}

Return a JSON ARRAY (not an object) matching EXACTLY this schema:
[
  {
    "day": "Monday",
    "date": "YYYY-MM-DD",
    "mealType": "breakfast",
    "recipe": ${RECIPE_SCHEMA}
  }
]`;

function buildRegenSynthesisMessage(req: MealPlanRequest, enriched: EnrichedRecipe[]): string {
  return `Generate replacement recipes for the specific meal slots listed below.

USER PREFERENCES:
${preferenceSummary(req)}
${allergenGuardSection(req.dietary.allergens)}
${dayContextSection(req)}

REAL RECIPE DATA RETRIEVED FROM THE WEB:
${buildRecipeBlocks(enriched)}`;
}

export async function regenerateMeals(
  req: MealPlanRequest,
  onProgress: (msg: string) => void = () => {}
): Promise<unknown> {
  if (req.searchMode === 'training') return regenerateMealsFromTraining(req, onProgress);
  if (!req.slotsToGenerate?.length) throw new Error('No slots specified for regeneration');

  // Phase 1 — Plan only the specified slots
  onProgress('Choosing replacement recipes…');
  const planMsg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    system: PLANNING_SYSTEM,
    messages: [{ role: 'user', content: buildPlanningMessage(req) }],
  });

  const planRaw = planMsg.content[0];
  if (planRaw.type !== 'text') throw new Error('Unexpected response from planning phase');
  const slots = parseJSON(planRaw.text) as RecipeSlot[];
  onProgress(`Selected ${slots.length} replacement recipe${slots.length === 1 ? '' : 's'} — searching the web…`);

  // Phase 2 — Tavily enrich those slots
  const enriched = await enrichRecipes(slots, onProgress);

  // Phase 3 — Synthesise just the requested meals as a JSON array
  onProgress('Writing your updated meals…');
  const synthMsg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 6000,
    system: REGEN_SYNTHESIS_SYSTEM,
    messages: [{ role: 'user', content: buildRegenSynthesisMessage(req, enriched) }],
  });

  const synthRaw = synthMsg.content[0];
  if (synthRaw.type !== 'text') throw new Error('Unexpected response from synthesis phase');
  const regenMeals = parseJSON(synthRaw.text) as { day: string; date: string; mealType: string; recipe: Record<string, unknown> }[];
  return regenMeals.map((m) => {
    const src = enriched.find((r) => r.day === m.day && r.mealType === m.mealType);
    return { ...m, recipe: { ...m.recipe, sourceUrl: src?.sourceUrl ?? null, imageUrl: src?.imageUrl ?? null } };
  });
}

// ── Training-only pipeline — Claude generates recipes from its own knowledge,
// no Tavily search/extract step. One Claude call does selection + synthesis
// together, instead of the plan → search → synthesize chain used above.

const TRAINING_RULES = `CRITICAL RULES:
1. Return ONLY raw valid JSON. No prose, no markdown, no code fences.
2. Invent each recipe yourself from your own training knowledge — do not claim to have searched or retrieved anything from the web.
3. Set "sourceSite" to "Claude" for every recipe.
4. Estimate macros accurately and consistently with the ingredient quantities you specify.
5. Strictly respect all dietary restrictions, allergen exclusions, per-meal macro limits (including minimum protein targets), and the remaining day budget where provided.
6. Never include any blacklisted recipe.`;

const TRAINING_DAY_SYSTEM = `You are a professional chef and meal planner. You do not have web access for this task — invent realistic, cookable recipes entirely from your own training knowledge.

${TRAINING_RULES}

Return a JSON ARRAY of meal objects for the day — one entry per meal slot:
[
  { "mealType": "breakfast", "recipe": ${RECIPE_SCHEMA} }
]`;

const TRAINING_REGEN_SYSTEM = `You are a professional chef and meal planner. You do not have web access for this task — invent realistic, cookable recipes entirely from your own training knowledge.

${TRAINING_RULES}

Return a JSON ARRAY (not an object) matching EXACTLY this schema:
[
  {
    "day": "Monday",
    "date": "YYYY-MM-DD",
    "mealType": "breakfast",
    "recipe": ${RECIPE_SCHEMA}
  }
]`;

// Deterministically spreads pinned recipes across days so each pinned recipe
// is generated exactly once (no separate cross-day planning call to dedupe them).
function assignPinnedToDays(
  pinnedRecipes: { name: string; cuisineHint: string; mealType: string }[] | undefined,
  days: { day: string; date: string }[]
): Map<string, { name: string; cuisineHint: string; mealType: string }[]> {
  const byDay = new Map<string, { name: string; cuisineHint: string; mealType: string }[]>();
  if (!pinnedRecipes?.length) return byDay;

  const usedDaysForType = new Map<string, Set<string>>();
  for (const pinned of pinnedRecipes) {
    const usedDays = usedDaysForType.get(pinned.mealType) ?? new Set<string>();
    const target = days.find((d) => !usedDays.has(d.day));
    if (!target) continue;
    usedDays.add(target.day);
    usedDaysForType.set(pinned.mealType, usedDays);
    byDay.set(target.day, [...(byDay.get(target.day) ?? []), pinned]);
  }
  return byDay;
}

function buildTrainingDayMessage(
  req: MealPlanRequest,
  day: { day: string; date: string },
  pinnedForDay: { name: string; cuisineHint: string; mealType: string }[]
): string {
  const mealTypes = getMealTypes(req.mealsPerDay);
  const pinnedSection = pinnedForDay.length
    ? `\nREQUIRED RECIPES TO INCLUDE (assign to the matching meal type; still write full original content for it):\n${pinnedForDay.map((p) => `- "${p.name}" (${p.cuisineHint}) as ${p.mealType}`).join('\n')}`
    : '';

  return `Generate a full day of meals for ${day.day} (${day.date}). Meal slots: ${mealTypes.join(', ')}.
${pinnedSection}

USER PREFERENCES:
${preferenceSummary(req)}
${perMealTargetsSection(req)}
${allergenGuardSection(req.dietary.allergens)}`;
}

function stampAiGenerated(recipe: Record<string, unknown>): Record<string, unknown> {
  return { ...recipe, sourceSite: 'Claude', sourceUrl: null, imageUrl: null, aiGenerated: true };
}

async function synthesizeTrainingDay(
  req: MealPlanRequest,
  day: { day: string; date: string },
  pinnedForDay: { name: string; cuisineHint: string; mealType: string }[]
): Promise<{ mealType: string; recipe: unknown }[]> {
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 6000,
    system: TRAINING_DAY_SYSTEM,
    messages: [{ role: 'user', content: buildTrainingDayMessage(req, day, pinnedForDay) }],
  });
  const raw = msg.content[0];
  if (raw.type !== 'text') throw new Error(`Unexpected response synthesizing ${day.day}`);
  return parseJSON(raw.text) as { mealType: string; recipe: unknown }[];
}

export async function generateMealPlanFromTraining(
  req: MealPlanRequest,
  onProgress: (msg: string) => void = () => {}
): Promise<unknown> {
  onProgress('Generating recipes from training knowledge…');
  const { weekOf, days } = getPlanDates(req.startDate, req.numDays);
  const pinnedByDay = assignPinnedToDays(req.pinnedRecipes, days);

  let daysWritten = 0;
  const mealPlanDays = await Promise.all(
    days.map(async (d) => {
      const meals = await synthesizeTrainingDay(req, d, pinnedByDay.get(d.day) ?? []);
      onProgress(`(${++daysWritten}/${days.length})`);
      const stampedMeals = meals.map((meal) => ({
        ...meal,
        recipe: stampAiGenerated(meal.recipe as Record<string, unknown>),
      }));
      return { day: d.day, date: d.date, meals: stampedMeals };
    })
  );

  const shoppingList = buildShoppingList(mealPlanDays);
  return { weekOf, mealPlan: mealPlanDays, shoppingList };
}

function buildTrainingRegenMessage(req: MealPlanRequest): string {
  const slots = req.slotsToGenerate ?? [];
  return `Generate replacement recipes for the specific meal slots listed below.

MEAL SLOTS TO FILL:
${slots.map((s) => `${s.day} ${s.date} — ${s.mealType}`).join('\n')}

USER PREFERENCES:
${preferenceSummary(req)}
${allergenGuardSection(req.dietary.allergens)}
${dayContextSection(req)}`;
}

export async function regenerateMealsFromTraining(
  req: MealPlanRequest,
  onProgress: (msg: string) => void = () => {}
): Promise<unknown> {
  if (!req.slotsToGenerate?.length) throw new Error('No slots specified for regeneration');

  onProgress('Generating replacement recipes from training knowledge…');
  const synthMsg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 6000,
    system: TRAINING_REGEN_SYSTEM,
    messages: [{ role: 'user', content: buildTrainingRegenMessage(req) }],
  });

  const synthRaw = synthMsg.content[0];
  if (synthRaw.type !== 'text') throw new Error('Unexpected response from synthesis phase');
  const regenMeals = parseJSON(synthRaw.text) as { day: string; date: string; mealType: string; recipe: Record<string, unknown> }[];
  return regenMeals.map((m) => ({ ...m, recipe: stampAiGenerated(m.recipe) }));
}
