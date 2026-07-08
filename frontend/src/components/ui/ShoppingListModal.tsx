import { useState, useEffect, useMemo } from 'react';
import type { ShoppingItem } from '../../types/mealPlan';
import { useKrogerStore, type ProductMatchMode, type ProductSortKey } from '../../store/useKrogerStore';
import { useMealPlanStore } from '../../store/useMealPlanStore';
import { usePantryStore } from '../../store/usePantryStore';
import { useProductCorrectionsStore } from '../../store/useProductCorrectionsStore';
import { useAccessStore } from '../../store/useAccessStore';
import { canonicalIngredientKey, singularize, normalizeIngredientAliases } from '../../utils/ingredientKey';
import FullAccessRequiredModal from './FullAccessRequiredModal';
import {
  searchKrogerLocations,
  searchKrogerProducts,
  addToKrogerCart,
  verifyProductMatches,
  type CartPayloadItem,
  type ProductOption,
  type ProductSearchResult,
  type KrogerLocation,
  type ArbitrationItem,
} from '../../services/krogerApi';

interface Props {
  items: ShoppingItem[];
  onClose: () => void;
}

type SortKey = 'alpha-asc' | 'alpha-desc' | 'recipes-desc' | 'recipes-asc';
type FilterKey = 'all' | 'selected' | 'unselected';
type ProductFilterKey = 'all' | 'in-stock' | 'on-sale';

type Phase =
  | { name: 'list' }
  | { name: 'store-picker' }
  | { name: 'searching' }
  | { name: 'confirming'; results: ProductSearchResult[]; selections: Map<string, ProductOption>; quantities: Map<string, number>; confidence: Map<string, boolean>; notFound: Set<string>; claudeRejected: Set<string>; pickedByClaudeDirectly: boolean }
  // `queue`/`queueIndex` are only set when entered via "Manually Review Items" —
  // they drive the Back/Next/Finish navigation between a chosen set of
  // ingredients. Absent when entered reactively via a single row's "Change".
  | { name: 'editing'; results: ProductSearchResult[]; selections: Map<string, ProductOption>; quantities: Map<string, number>; confidence: Map<string, boolean>; notFound: Set<string>; claudeRejected: Set<string>; pickedByClaudeDirectly: boolean; rowKey: string; queue?: string[]; queueIndex?: number }
  | { name: 'adding' }
  | { name: 'done'; addedCount: number; addedTerms: string[] }
  | { name: 'error'; message: string };

// Auto-picks a default product per ingredient. Kroger's own relevance ranking
// isn't reliable enough to trust on its own (e.g. "mint leaves" ranking breath
// gum highly on word overlap), so instead of just taking Kroger's top few and
// picking cheapest, we score every candidate three ways:
//   1. Text coverage — how many of the search term's meaningful words actually
//      appear in the description. Requiring ALL of them (not just one) matters
//      for multi-word ingredients: "toasted rice powder" sharing only the word
//      "rice" with some unrelated flavored-rice product isn't a real match.
//   2. Phrase adjacency — among candidates tied on word coverage, the words
//      appearing together ("Thai Bird Chili") is a stronger signal than the
//      same words scattered independently through an unrelated description.
//   3. Department plausibility (`looksLikeIngredient`, computed server-side) —
//      snacks/beverages/candy routinely borrow flavor names from real
//      ingredients ("Lemongrass Sparkling Water"), so a product can win on
//      text alone and still be the wrong *kind* of thing entirely.
// A pick only counts as confident when it wins on all three — otherwise we
// still pick something (better than leaving it blank) but flag it for the
// user.
//
// How many of those already-gated candidates to price-compare is user-tunable
// (see ProductMatchMode) — widening the pool never lets a worse-matching
// candidate back in, since it only competes candidates that already passed
// both checks above; it just decides how hard to shop among equally-valid
// options versus trusting Kroger's own top relevance pick.
export const MATCH_MODE_POOL_SIZES: Record<ProductMatchMode, number> = {
  accuracy: 1,
  balanced: 3,
  price: 10,
};

// Words too generic to count as a meaningful match on their own — mirrors the
// prep/part words the backend strips before searching Kroger.
const GENERIC_SEARCH_WORDS = new Set([
  'fresh', 'dried', 'frozen', 'canned', 'raw', 'whole', 'sliced', 'chopped',
  'minced', 'diced', 'shredded', 'peeled', 'halved', 'quartered', 'toasted',
  'roasted', 'sprig', 'sprigs', 'stalk', 'stalks', 'bunch', 'bunches',
  'leaf', 'leaves', 'piece', 'pieces', 'and', 'or', 'the', 'of',
]);

function coreTokens(term: string): string[] {
  return normalizeIngredientAliases(term)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !GENERIC_SEARCH_WORDS.has(w))
    .map((w) => singularize(w));
}

function overlapScore(tokens: string[], description: string): number {
  const desc = normalizeIngredientAliases(description);
  // Allow a plain plural suffix on the description side — tokens are already
  // singularized, but descriptions ("Onions", "Chilies") usually aren't.
  return tokens.filter((t) => new RegExp(`\\b${t}(?:e?s)?\\b`).test(desc)).length;
}

// Bag-of-words overlap alone can't tell "Thai Bird Chili" appearing together
// from the same three words scattered across an unrelated description. Only
// meaningful for multi-word searches — a single token has no order to check.
// Allows a short gap (punctuation, "'s", a filler word) between consecutive
// words so reasonable formatting differences don't defeat it, without
// allowing the words to be scattered arbitrarily far apart.
function phraseMatch(tokens: string[], description: string): boolean {
  if (tokens.length < 2) return true;
  const desc = normalizeIngredientAliases(description);
  const pattern = tokens.map((t) => `${t}(?:e?s)?`).join('[^a-z0-9]{0,15}');
  return new RegExp(`\\b${pattern}\\b`).test(desc);
}

// Normalizing through the full shopping-list merge key (not just the alias
// table) means a correction remembered for "olive oil" is still found next
// time the recipe says "extra virgin olive oil," "Shallot" vs "Shallots," etc.
function correctionKey(searchTerm: string): string {
  return canonicalIngredientKey(searchTerm);
}

export interface AutoSelection {
  option: ProductOption;
  confident: boolean;
}

function autoSelectProduct(options: ProductOption[], searchTerm: string, poolSize: number): AutoSelection | null {
  if (options.length === 0) return null;

  const key = correctionKey(searchTerm);
  const store = useProductCorrectionsStore.getState();

  // A remembered manual correction always wins, as long as the same product
  // still shows up among this search's results.
  const remembered = store.corrections[key];
  if (remembered) {
    const match = options.find((o) => o.productId === remembered);
    if (match) return { option: match, confident: true };
  }

  // Products explicitly rejected for this ingredient before should never be
  // auto-picked again.
  const excluded = store.exclusions[key];
  const eligible = excluded?.length ? options.filter((o) => !excluded.includes(o.productId)) : options;
  if (eligible.length === 0) return null;

  const inStock = eligible.filter((o) => o.stockLevel !== 'TEMPORARILY_OUT_OF_STOCK');
  const candidates = inStock.length > 0 ? inStock : eligible;

  const tokens = coreTokens(searchTerm);
  const scored = candidates.map((o) => ({ o, score: tokens.length ? overlapScore(tokens, o.description) : 0 }));
  const maxScore = Math.max(...scored.map((s) => s.score));

  // Preserve Kroger's relevance order within whichever tier we use.
  const tier = maxScore > 0 ? scored.filter((s) => s.score === maxScore) : scored;

  // Among candidates tied on word overlap, further prefer ones where the
  // words actually appear together as a phrase, not just scattered
  // independently through the description.
  const phrased = tier.filter((s) => phraseMatch(tokens, s.o.description));
  const textTier = phrased.length > 0 ? phrased : tier;

  // Within that, prefer candidates that actually look like a cooking
  // ingredient before considering price — a beverage or snack sharing the
  // ingredient's name shouldn't out-compete a real produce/spice listing
  // just because it happens to be cheaper.
  const plausible = textTier.filter((s) => s.o.looksLikeIngredient);
  const pool = (plausible.length > 0 ? plausible : textTier).slice(0, poolSize).map((s) => s.o);

  // Kroger's own top-ranked candidate within the valid tier — what "Accurate"
  // mode (pool size 1) would have picked.
  const topRelevance = pool[0];
  const best = pool.reduce((best, o) => {
    const price = o.promoPrice ?? o.regularPrice ?? Infinity;
    const bestPrice = best.promoPrice ?? best.regularPrice ?? Infinity;
    return price < bestPrice ? o : best;
  }, pool[0]);

  // Widening the pool (Balanced/Cheapest) only ever chooses among candidates
  // that already passed the checks above, but swapping Kroger's own top pick
  // for a cheaper alternative is still a real, separate source of risk — a
  // technically-valid substitution can still be the wrong brand/size/form for
  // what was actually needed. That risk scales with pool size (a wider net
  // finds more substitutions), which is exactly why "Cheapest" should flag
  // more items than "Accurate" — so it counts against confidence too, not
  // just full text coverage and department plausibility.
  const substitutedForPrice = best.productId !== topRelevance.productId;

  const fullTextMatch = tokens.length > 0 && maxScore === tokens.length;
  const confident = fullTextMatch && best.looksLikeIngredient && !substitutedForPrice && phraseMatch(tokens, best.description);

  return { option: best, confident };
}

// Ranks ALL candidates by the same relevance signals autoSelectProduct uses
// (word coverage, phrase adjacency, department plausibility) instead of
// discarding everything but the winner — used to offer a genuine "Most
// relevant" sort in the manual product browser, as opposed to just trusting
// Kroger's own result order (which autoSelectProduct's own doc comment notes
// isn't reliable enough on its own).
function rankCandidatesByRelevance(options: ProductOption[], searchTerm: string): ProductOption[] {
  const tokens = coreTokens(searchTerm);
  return options
    .map((o, i) => ({
      o,
      i,
      score: tokens.length ? overlapScore(tokens, o.description) : 0,
      phrased: phraseMatch(tokens, o.description),
    }))
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      if (a.phrased !== b.phrased) return a.phrased ? -1 : 1;
      if (a.o.looksLikeIngredient !== b.o.looksLikeIngredient) return a.o.looksLikeIngredient ? -1 : 1;
      return a.i - b.i; // stable — Kroger's own order is the final tiebreaker
    })
    .map((s) => s.o);
}

// ── Quantity matching ─────────────────────────────────────────────────────────
// Units that ARE the retail package itself — a "can"/"jar"/"box" of something is
// always one product unit, so defaulting to pack size 1 here is a safe guess
// even without spotting an explicit multi-pack count in the product text.
const SAFE_PACKAGE_UNITS = new Set([
  'can', 'cans', 'jar', 'jars', 'bottle', 'bottles', 'box', 'boxes', 'package', 'packages', 'bag', 'bags',
]);

// Units that describe a piece of food, not the retail package (a recipe's
// "6 cloves" of garlic says nothing about how many cloves are in the bulb
// Kroger sells) — only multiply these when the product text explicitly states
// a pack count; otherwise leave quantity at 1 rather than guess.
const AMBIGUOUS_COUNT_UNITS = new Set([
  '', 'whole', 'each', 'large', 'medium', 'small', 'clove', 'cloves', 'slice', 'slices',
  'piece', 'pieces', 'stalk', 'stalks', 'sprig', 'sprigs', 'head', 'heads',
  'fillet', 'fillets', 'ear', 'ears', 'bunch', 'bunches',
]);

function parseNeededCount(estimatedQuantity: string): { count: number; safePackageUnit: boolean } | null {
  const trimmed = estimatedQuantity.trim();
  if (trimmed.includes('+')) return null; // mixed units combined across recipes — too ambiguous
  const m = trimmed.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/);
  if (!m) return null;
  const unit = m[2].toLowerCase();
  if (SAFE_PACKAGE_UNITS.has(unit)) return { count: Math.ceil(parseFloat(m[1])), safePackageUnit: true };
  if (AMBIGUOUS_COUNT_UNITS.has(unit)) return { count: Math.ceil(parseFloat(m[1])), safePackageUnit: false };
  return null;
}

function parsePackSize(opt: ProductOption): number | null {
  const m = `${opt.size} ${opt.description}`.match(/(\d+)[\s-]*(?:ct\.?|count|pk\.?|pack)\b/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n > 0 ? n : null;
}

const MAX_AUTO_BUY_UNITS = 12;

// How many of the chosen product to buy so the total covers what the recipes
// need — e.g. need 6 onions, product is a 3-count bag → buy 2. Falls back to 1
// (no guess) whenever the unit or package size is ambiguous, since silently
// over-buying is worse than leaving it for the user to check.
function computeBuyQuantity(estimatedQuantity: string, opt: ProductOption): number {
  const need = parseNeededCount(estimatedQuantity);
  if (!need || opt.soldBy === 'WEIGHT') return 1;
  const packSize = parsePackSize(opt) ?? (need.safePackageUnit ? 1 : null);
  if (packSize === null) return 1;
  const units = Math.ceil(need.count / packSize);
  return units > 0 && units <= MAX_AUTO_BUY_UNITS ? units : 1;
}

function krogerUrl(productId: string, description: string): string {
  const slug = description.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `https://www.kroger.com/p/${slug}/${productId}`;
}

function proxyImage(url: string | null): string | null {
  if (!url) return null;
  return `/api/kroger/image?url=${encodeURIComponent(url)}`;
}

function PriceDisplay({ regular, promo }: { regular: number | null; promo: number | null }) {
  if (promo !== null && regular !== null && promo < regular) {
    return (
      <span className="product-card__price">
        <span className="product-card__price-promo">${promo.toFixed(2)}</span>
        <span className="product-card__price-was">${regular.toFixed(2)}</span>
      </span>
    );
  }
  if (regular !== null) {
    return <span className="product-card__price product-card__price-regular">${regular.toFixed(2)}</span>;
  }
  return null;
}

function ProductCard({
  opt,
  selected,
  onToggle,
}: {
  opt: ProductOption;
  selected: boolean;
  onToggle: () => void;
}) {
  const [imgErr, setImgErr] = useState(false);

  return (
    <div
      className={`product-card${selected ? ' product-card--selected' : ''}`}
      onClick={onToggle}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onToggle()}
    >
      <div className="product-card__select-indicator">
        {selected && <span className="product-card__check">✓</span>}
      </div>

      <div className="product-card__img-wrap">
        {opt.imageUrl && !imgErr ? (
          <img
            src={proxyImage(opt.imageUrl) ?? ''}
            alt={opt.description}
            className="product-card__img"
            onError={() => setImgErr(true)}
          />
        ) : (
          <div className="product-card__img-placeholder">
            {opt.description.charAt(0).toUpperCase()}
          </div>
        )}
      </div>

      <div className="product-card__info">
        {opt.brand && <p className="product-card__brand">{opt.brand}</p>}
        <p className="product-card__name">{opt.description}</p>
        {opt.size && (
          <p className="product-card__size">
            {opt.size}{opt.soldBy === 'WEIGHT' ? ' · sold by weight' : ''}
          </p>
        )}
        {opt.categories.length > 0 && (
          <p className="product-card__category">{opt.categories[0]}</p>
        )}
        <PriceDisplay regular={opt.regularPrice} promo={opt.promoPrice} />
        {opt.stockLevel === 'LOW' && (
          <p className="product-card__stock-low">Low stock</p>
        )}
        {opt.stockLevel === 'TEMPORARILY_OUT_OF_STOCK' && (
          <p className="product-card__stock-out">Temporarily out of stock</p>
        )}
        <a
          href={krogerUrl(opt.productId, opt.description)}
          target="_blank"
          rel="noopener noreferrer"
          className="product-card__link"
          onClick={(e) => e.stopPropagation()}
        >
          View on Kroger ↗
        </a>
      </div>
    </div>
  );
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export default function ShoppingListModal({ items, onClose }: Props) {
  const { isConnected, locationId, locationName, setLocation, disconnect, matchMode, setMatchMode, candidateSort, setCandidateSort } = useKrogerStore();
  const hasFullAccess = useAccessStore((s) => s.trusted);
  const { cartedTerms, addToCarted, removeFromCarted, mealPlan } = useMealPlanStore();
  const { pantry, addToPantry, removeFromPantry } = usePantryStore();

  const [checked, setChecked] = useState<Set<string>>(() => {
    const carted = new Set(useMealPlanStore.getState().cartedTerms);
    const pantryNames = new Set(
      usePantryStore.getState().pantry.map((p) => canonicalIngredientKey(p.name))
    );
    return new Set(
      items
        .filter((i) =>
          !carted.has(i.krogerSearchTerm) &&
          !pantryNames.has(canonicalIngredientKey(i.displayName))
        )
        .map((i) => i.displayName)
    );
  });
  const [sort, setSort] = useState<SortKey>('alpha-asc');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [phase, setPhase] = useState<Phase>({ name: 'list' });
  const [productFilter, setProductFilter] = useState<ProductFilterKey>('all');
  const [showAllCandidates, setShowAllCandidates] = useState(false);
  const [checkAllForVerify, setCheckAllForVerify] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [claudeVerifyUsed, setClaudeVerifyUsed] = useState(false);
  const [claudeDirectMode, setClaudeDirectMode] = useState(false);
  const [showFullAccessModal, setShowFullAccessModal] = useState(false);
  // null = not choosing a manual-review scope; a Set = the scope-picker is open,
  // tracking which ingredients (by displayName) are checked so far.
  const [manualReviewScope, setManualReviewScope] = useState<Set<string> | null>(null);

  // Reset product filter and the top-N cap when navigating to a different
  // ingredient. Candidate sort is intentionally NOT reset here — it's
  // persisted in useKrogerStore so the preference carries across ingredients.
  useEffect(() => {
    if (phase.name === 'editing') {
      setProductFilter('all');
      setShowAllCandidates(false);
    }
  }, [phase.name === 'editing' ? phase.rowKey : null]); // eslint-disable-line react-hooks/exhaustive-deps

  // Store picker
  const [zip, setZip] = useState('');
  const [storeResults, setStoreResults] = useState<KrogerLocation[]>([]);
  const [storeSearching, setStoreSearching] = useState(false);
  const [storeError, setStoreError] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [onClose]);

  // ── Checklist ──────────────────────────────────────────────────────────────

  function toggle(key: string) {
    setChecked((p) => { const n = new Set(p); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }
  function toggleAll() {
    setChecked((prev) => {
      const next = new Set(prev);
      for (const i of nonPantryItems) {
        if (allNonPantryChecked) next.delete(i.displayName);
        else next.add(i.displayName);
      }
      return next;
    });
  }

  function moveToList(item: ShoppingItem) {
    removeFromCarted(item.krogerSearchTerm);
    removeFromPantry(item.displayName);
    setChecked((p) => { const n = new Set(p); n.add(item.displayName); return n; });
  }

  function moveToPantry(item: ShoppingItem) {
    addToPantry([{ name: item.displayName }]);
    setChecked((p) => { const n = new Set(p); n.delete(item.displayName); return n; });
  }

  // Recipe name → cuisine, so Claude arbitration can tell "Thai Red Chilis"
  // apart from a generic hot chili pepper substitute instead of just seeing
  // the bare ingredient name.
  const recipeCuisines = useMemo(() => {
    const map = new Map<string, string>();
    if (!mealPlan) return map;
    for (const day of mealPlan.mealPlan) {
      for (const meal of day.meals) {
        map.set(meal.recipe.name, meal.recipe.cuisine);
      }
    }
    return map;
  }, [mealPlan]);

  // ── Sorted + filtered list ─────────────────────────────────────────────────

  const pantryNames = useMemo(
    () => new Set(pantry.map((p) => canonicalIngredientKey(p.name))),
    [pantry]
  );

  const nonPantryItems = useMemo(
    () => items.filter((i) => !pantryNames.has(canonicalIngredientKey(i.displayName))),
    [items, pantryNames]
  );
  const allNonPantryChecked =
    nonPantryItems.length > 0 && nonPantryItems.every((i) => checked.has(i.displayName));

  const displayItems = useMemo(() => {
    let list = [...items];
    if (filter === 'selected')   list = list.filter((i) => checked.has(i.displayName));
    if (filter === 'unselected') list = list.filter((i) => !checked.has(i.displayName));
    list.sort((a, b) => {
      const tier = (i: ShoppingItem) => {
        if (cartedTerms.includes(i.krogerSearchTerm)) return 1;
        if (pantryNames.has(canonicalIngredientKey(i.displayName))) return 2;
        return 0;
      };
      const ta = tier(a), tb = tier(b);
      if (ta !== tb) return ta - tb;
      if (sort === 'alpha-asc')    return a.displayName.localeCompare(b.displayName);
      if (sort === 'alpha-desc')   return b.displayName.localeCompare(a.displayName);
      if (sort === 'recipes-desc') return b.usedIn.length - a.usedIn.length;
      if (sort === 'recipes-asc')  return a.usedIn.length - b.usedIn.length;
      return 0;
    });
    return list;
  }, [items, filter, sort, checked, cartedTerms, pantryNames]);

  const cartedSet = new Set(cartedTerms);

  const cartPayload: CartPayloadItem[] = items
    .filter((i) => checked.has(i.displayName))
    .map((i) => ({ krogerSearchTerm: i.krogerSearchTerm, displayName: i.displayName }));

  // ── Store picker ───────────────────────────────────────────────────────────

  async function handleSearchStores() {
    if (!zip.trim()) return;
    setStoreSearching(true); setStoreError(''); setStoreResults([]);
    try {
      const results = await searchKrogerLocations(zip.trim());
      if (!results.length) setStoreError('No stores found near that ZIP code.');
      setStoreResults(results);
    } catch (err) {
      setStoreError(err instanceof Error ? err.message : 'Could not find stores.');
    } finally { setStoreSearching(false); }
  }

  function handleSelectStore(loc: KrogerLocation) {
    setLocation(loc.locationId, `${loc.name} – ${loc.address}`);
    setStoreResults([]); setZip('');
    setPhase({ name: 'list' });
  }

  // ── Product search ─────────────────────────────────────────────────────────

  async function handleFindProducts() {
    if (!locationId || !cartPayload.length) return;
    setPhase({ name: 'searching' });
    setClaudeVerifyUsed(false);
    setVerifyError(null);
    try {
      const results = await searchKrogerProducts(cartPayload, locationId);

      // Defense in depth — the checkbox is hidden without Full Access, but
      // don't trust stale client state (e.g. access lapsed mid-session) over
      // what the backend will actually enforce anyway.
      if (claudeDirectMode && hasFullAccess) {
        await resolveWithClaudeDirectly(results);
        return;
      }

      runAlgorithmOnResults(results);
    } catch (err) {
      setPhase({ name: 'error', message: err instanceof Error ? err.message : 'Search failed' });
    }
  }

  // Keyed by displayName, not krogerSearchTerm — two different shopping-list
  // rows (e.g. "Toasted Sesame Seeds" and "Sesame Seeds") can share the same
  // krogerSearchTerm, which would silently collapse their entries together.
  // `fallbackNotice`, when set, means this ran because Claude-direct mode
  // failed (e.g. rate limited) — surfaced as a visible notice rather than
  // silently substituting the algorithm's picks without saying so.
  function runAlgorithmOnResults(results: ProductSearchResult[], fallbackNotice?: string) {
    const selections = new Map<string, ProductOption>();
    const quantities = new Map<string, number>();
    const confidence = new Map<string, boolean>();
    const notFound = new Set<string>();
    for (const r of results) {
      const picked = autoSelectProduct(r.options, r.krogerSearchTerm, MATCH_MODE_POOL_SIZES[matchMode]);
      if (picked) {
        selections.set(r.displayName, picked.option);
        confidence.set(r.displayName, picked.confident);
        const shoppingItem = items.find((i) => i.displayName === r.displayName);
        quantities.set(r.displayName, shoppingItem ? computeBuyQuantity(shoppingItem.estimatedQuantity, picked.option) : 1);
      } else {
        notFound.add(r.displayName);
      }
    }
    setPhase({ name: 'confirming', results, selections, quantities, confidence, notFound, claudeRejected: new Set(), pickedByClaudeDirectly: false });
    if (fallbackNotice) {
      setVerifyError(`Claude product matching failed (${fallbackNotice}) — showing algorithm-based matches instead.`);
    }
  }

  // Claude picks every ingredient directly instead of the token/department
  // algorithm. Remembered corrections and exclusions still take precedence —
  // a prior manual decision shouldn't be re-litigated by Claude every time —
  // so only the remaining rows actually go into the batched request.
  async function resolveWithClaudeDirectly(results: ProductSearchResult[]) {
    const selections = new Map<string, ProductOption>();
    const quantities = new Map<string, number>();
    const confidence = new Map<string, boolean>();
    const notFound = new Set<string>();
    const claudeRejected = new Set<string>();

    const store = useProductCorrectionsStore.getState();
    const requestItems: ArbitrationItem[] = [];

    for (const r of results) {
      if (r.options.length === 0) { notFound.add(r.displayName); continue; }

      const key = correctionKey(r.krogerSearchTerm);
      const shoppingItem = items.find((i) => i.displayName === r.displayName);

      const remembered = store.corrections[key];
      const rememberedMatch = remembered ? r.options.find((o) => o.productId === remembered) : undefined;
      if (rememberedMatch) {
        selections.set(r.displayName, rememberedMatch);
        confidence.set(r.displayName, true);
        quantities.set(r.displayName, shoppingItem ? computeBuyQuantity(shoppingItem.estimatedQuantity, rememberedMatch) : 1);
        continue;
      }

      const excluded = store.exclusions[key];
      const eligible = excluded?.length ? r.options.filter((o) => !excluded.includes(o.productId)) : r.options;
      if (eligible.length === 0) { notFound.add(r.displayName); continue; }

      const inStock = eligible.filter((o) => o.stockLevel !== 'TEMPORARILY_OUT_OF_STOCK');
      const pool = (inStock.length > 0 ? inStock : eligible).slice(0, 8);

      const usedIn = shoppingItem?.usedIn ?? [];
      const cuisines = [...new Set(usedIn.map((name) => recipeCuisines.get(name)).filter((c): c is string => !!c))];
      const recipeContext = usedIn.length
        ? `Used in: ${usedIn.join(', ')}${cuisines.length ? ` (${cuisines.join('/')} cuisine)` : ''}`
        : undefined;

      requestItems.push({
        key: r.displayName,
        ingredientName: r.displayName,
        searchTerm: r.krogerSearchTerm,
        neededQuantity: shoppingItem?.estimatedQuantity ?? '',
        recipeContext,
        candidates: pool.map((o) => ({
          productId: o.productId,
          brand: o.brand,
          description: o.description,
          size: o.size,
          regularPrice: o.regularPrice,
          promoPrice: o.promoPrice,
          stockLevel: o.stockLevel,
        })),
      });
    }

    try {
      if (requestItems.length > 0) {
        const claudeResults = await verifyProductMatches(requestItems);
        const handledKeys = new Set<string>();

        for (const result of claudeResults) {
          handledKeys.add(result.key);
          const resultRow = results.find((r) => r.displayName === result.key);
          if (!resultRow) continue;

          const opt = result.productId ? resultRow.options.find((o) => o.productId === result.productId) : undefined;
          if (opt) {
            selections.set(result.key, opt);
            confidence.set(result.key, result.confident ?? true);
            const shoppingItem = items.find((i) => i.displayName === result.key);
            quantities.set(result.key, shoppingItem ? computeBuyQuantity(shoppingItem.estimatedQuantity, opt) : 1);
          } else {
            claudeRejected.add(result.key);
          }
        }

        // Defensive: if Claude's response ever omits a requested item, don't
        // silently leave it looking untouched — flag it the same as a no-match.
        for (const item of requestItems) {
          if (!handledKeys.has(item.key)) claudeRejected.add(item.key);
        }
      }

      setPhase({ name: 'confirming', results, selections, quantities, confidence, notFound, claudeRejected, pickedByClaudeDirectly: true });
    } catch (err) {
      // Claude failed (rate limited, network error, etc.) — don't strand the
      // user with nothing; fall back to the algorithm on the same
      // already-fetched results (autoSelectProduct re-applies corrections/
      // exclusions on its own, so nothing from the attempt above is lost).
      runAlgorithmOnResults(results, err instanceof Error ? err.message : 'unknown error');
    }
  }

  // ── Ask Claude to arbitrate uncertain matches ──────────────────────────────

  function rowsEligibleForVerify(): ProductSearchResult[] {
    if (phase.name !== 'confirming') return [];
    return phase.results.filter((r) => {
      if (r.options.length === 0) return false; // nothing for Claude to choose from
      if (checkAllForVerify) return true;
      const sel = phase.selections.get(r.displayName);
      const confident = phase.confidence.get(r.displayName);
      return !sel || confident === false;
    });
  }

  async function handleAskClaude() {
    if (phase.name !== 'confirming' || !hasFullAccess) return;
    const eligible = rowsEligibleForVerify();
    if (eligible.length === 0) return;

    setVerifying(true);
    setVerifyError(null);
    try {
      const requestItems: ArbitrationItem[] = eligible.map((r) => {
        const shoppingItem = items.find((i) => i.displayName === r.displayName);
        // Same in-stock preference used elsewhere, capped for token cost —
        // the backend caps again regardless, this just keeps the request small.
        const inStock = r.options.filter((o) => o.stockLevel !== 'TEMPORARILY_OUT_OF_STOCK');
        const pool = (inStock.length > 0 ? inStock : r.options).slice(0, 8);

        const usedIn = shoppingItem?.usedIn ?? [];
        const cuisines = [...new Set(usedIn.map((name) => recipeCuisines.get(name)).filter((c): c is string => !!c))];
        const recipeContext = usedIn.length
          ? `Used in: ${usedIn.join(', ')}${cuisines.length ? ` (${cuisines.join('/')} cuisine)` : ''}`
          : undefined;

        return {
          key: r.displayName,
          ingredientName: r.displayName,
          searchTerm: r.krogerSearchTerm,
          neededQuantity: shoppingItem?.estimatedQuantity ?? '',
          recipeContext,
          candidates: pool.map((o) => ({
            productId: o.productId,
            brand: o.brand,
            description: o.description,
            size: o.size,
            regularPrice: o.regularPrice,
            promoPrice: o.promoPrice,
            stockLevel: o.stockLevel,
          })),
        };
      });

      const results = await verifyProductMatches(requestItems);

      setPhase((prev) => {
        if (prev.name !== 'confirming') return prev;
        const nextSel = new Map(prev.selections);
        const nextQty = new Map(prev.quantities);
        const nextConf = new Map(prev.confidence);
        const nextRejected = new Set(prev.claudeRejected);

        for (const result of results) {
          const resultRow = prev.results.find((r) => r.displayName === result.key);
          if (!resultRow) continue;

          if (result.productId) {
            const opt = resultRow.options.find((o) => o.productId === result.productId);
            if (opt) {
              nextSel.set(result.key, opt);
              nextConf.set(result.key, result.confident ?? true);
              const shoppingItem = items.find((i) => i.displayName === result.key);
              nextQty.set(result.key, shoppingItem ? computeBuyQuantity(shoppingItem.estimatedQuantity, opt) : 1);
              nextRejected.delete(result.key);
            }
          } else {
            nextSel.delete(result.key);
            nextQty.delete(result.key);
            nextConf.delete(result.key);
            nextRejected.add(result.key);
          }
        }

        return { ...prev, selections: nextSel, quantities: nextQty, confidence: nextConf, claudeRejected: nextRejected };
      });
      // Only lock the button out on success — a failed attempt (rate limit,
      // network error) should stay retryable.
      setClaudeVerifyUsed(true);
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setVerifying(false);
    }
  }

  // ── Product sort/filter ────────────────────────────────────────────────────

  // Default number of candidates shown per ingredient in the manual product
  // browser — enough to almost always include the right item without
  // overwhelming a manual review session. "Show all" always escapes this.
  const CANDIDATE_CAP = 6;

  function applyProductControls(opts: ProductOption[], searchTerm: string): ProductOption[] {
    let list = [...opts];
    if (productFilter === 'in-stock') list = list.filter((o) => o.stockLevel !== 'TEMPORARILY_OUT_OF_STOCK');
    if (productFilter === 'on-sale')  list = list.filter((o) => o.promoPrice !== null && o.regularPrice !== null && o.promoPrice < o.regularPrice);
    if (candidateSort === 'relevance') {
      list = rankCandidatesByRelevance(list, searchTerm);
    } else if (candidateSort !== 'kroger') {
      // 'kroger' means leave the list in whatever order it arrived — Kroger's
      // own relevance ranking. Every other option is a real re-sort.
      list.sort((a, b) => {
        if (candidateSort === 'price-asc')  return (a.promoPrice ?? a.regularPrice ?? Infinity) - (b.promoPrice ?? b.regularPrice ?? Infinity);
        if (candidateSort === 'price-desc') return (b.promoPrice ?? b.regularPrice ?? -Infinity) - (a.promoPrice ?? a.regularPrice ?? -Infinity);
        if (candidateSort === 'alpha-asc')  return a.description.localeCompare(b.description);
        if (candidateSort === 'alpha-desc') return b.description.localeCompare(a.description);
        return 0;
      });
    }
    return list;
  }

  // ── Editing a single item's product choice ────────────────────────────────

  function openEditing(rowKey: string) {
    if (phase.name !== 'confirming') return;
    setPhase({ name: 'editing', results: phase.results, selections: phase.selections, quantities: phase.quantities, confidence: phase.confidence, notFound: phase.notFound, claudeRejected: phase.claudeRejected, pickedByClaudeDirectly: phase.pickedByClaudeDirectly, rowKey });
  }

  // ── Manual review mode (walk through a chosen set of ingredients) ─────────

  function needsVerification(r: ProductSearchResult): boolean {
    if (phase.name !== 'confirming') return false;
    const sel = phase.selections.get(r.displayName);
    return !sel || phase.confidence.get(r.displayName) === false;
  }

  function toggleManualReviewRow(key: string) {
    setManualReviewScope((prev) => {
      if (!prev) return prev;
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  function selectAllReviewable() {
    if (phase.name !== 'confirming') return;
    setManualReviewScope(new Set(phase.results.filter((r) => r.options.length > 0).map((r) => r.displayName)));
  }

  function selectFlaggedOnly() {
    if (phase.name !== 'confirming') return;
    setManualReviewScope(new Set(phase.results.filter((r) => r.options.length > 0 && needsVerification(r)).map((r) => r.displayName)));
  }

  // Opens the editing phase with a queue attached — used by both the scope
  // picker below and could be reused for other bulk-review entry points later.
  function startManualReview(rowKeys: string[]) {
    if (phase.name !== 'confirming' || rowKeys.length === 0) return;
    setPhase({ name: 'editing', results: phase.results, selections: phase.selections, quantities: phase.quantities, confidence: phase.confidence, notFound: phase.notFound, claudeRejected: phase.claudeRejected, pickedByClaudeDirectly: phase.pickedByClaudeDirectly, rowKey: rowKeys[0], queue: rowKeys, queueIndex: 0 });
    setManualReviewScope(null);
  }

  function beginManualReviewFromScope() {
    if (phase.name !== 'confirming' || !manualReviewScope) return;
    // Preserve the list's own order rather than click order — predictable
    // regardless of which rows were checked in what sequence.
    const ordered = phase.results.filter((r) => manualReviewScope.has(r.displayName)).map((r) => r.displayName);
    startManualReview(ordered);
  }

  function advanceQueue(direction: 1 | -1) {
    if (phase.name !== 'editing' || !phase.queue) return;
    const nextIndex = (phase.queueIndex ?? 0) + direction;
    if (nextIndex < 0 || nextIndex >= phase.queue.length) return;
    setPhase({ ...phase, rowKey: phase.queue[nextIndex], queueIndex: nextIndex });
  }

  function editSelect(opt: ProductOption) {
    if (phase.name !== 'editing') return;
    const nextSel = new Map(phase.selections);
    const nextQty = new Map(phase.quantities);
    const nextConf = new Map(phase.confidence);
    if (nextSel.get(phase.rowKey)?.productId === opt.productId) {
      nextSel.delete(phase.rowKey);
      nextQty.delete(phase.rowKey);
      nextConf.delete(phase.rowKey);
      // Explicitly rejecting a product for this ingredient means it
      // shouldn't be auto-picked for it again.
      const result = phase.results.find((r) => r.displayName === phase.rowKey);
      if (result) {
        useProductCorrectionsStore.getState().exclude(correctionKey(result.krogerSearchTerm), opt.productId);
      }
    } else {
      nextSel.set(phase.rowKey, opt);
      // A human just picked this deliberately — treat it as reviewed regardless
      // of what the word-overlap score would have said.
      nextConf.set(phase.rowKey, true);
      const shoppingItem = items.find((i) => i.displayName === phase.rowKey);
      nextQty.set(phase.rowKey, shoppingItem ? computeBuyQuantity(shoppingItem.estimatedQuantity, opt) : 1);

      // Remember this choice so future shopping lists auto-pick it directly.
      const result = phase.results.find((r) => r.displayName === phase.rowKey);
      if (result) {
        useProductCorrectionsStore.getState().remember(correctionKey(result.krogerSearchTerm), opt.productId);
      }
    }
    // A manual pick resolves any earlier "Claude found no match" verdict.
    const nextRejected = new Set(phase.claudeRejected);
    nextRejected.delete(phase.rowKey);
    setPhase({ ...phase, selections: nextSel, quantities: nextQty, confidence: nextConf, claudeRejected: nextRejected });
  }

  function removeEditingSelection() {
    if (phase.name !== 'editing') return;
    const nextSel = new Map(phase.selections);
    const nextQty = new Map(phase.quantities);
    const nextConf = new Map(phase.confidence);
    const removed = nextSel.get(phase.rowKey);
    nextSel.delete(phase.rowKey);
    nextQty.delete(phase.rowKey);
    nextConf.delete(phase.rowKey);
    if (removed) {
      const result = phase.results.find((r) => r.displayName === phase.rowKey);
      if (result) {
        useProductCorrectionsStore.getState().exclude(correctionKey(result.krogerSearchTerm), removed.productId);
      }
    }
    setPhase({ ...phase, selections: nextSel, quantities: nextQty, confidence: nextConf });
  }

  function closeEditing() {
    if (phase.name !== 'editing') return;
    setPhase({ name: 'confirming', results: phase.results, selections: phase.selections, quantities: phase.quantities, confidence: phase.confidence, notFound: phase.notFound, claudeRejected: phase.claudeRejected, pickedByClaudeDirectly: phase.pickedByClaudeDirectly });
  }

  // The top-right ✕ steps back one level rather than always closing the whole
  // modal — matches the footer's own Back/Done affordance at each phase.
  function handleTopClose() {
    if (phase.name === 'confirming') { setPhase({ name: 'list' }); return; }
    if (phase.name === 'editing') { closeEditing(); return; }
    onClose();
  }

  const topCloseLabel =
    phase.name === 'confirming' ? 'Back to Shopping List'
    : phase.name === 'editing' ? 'Back to Review Cart'
    : 'Close';

  // ── Cart add ───────────────────────────────────────────────────────────────

  async function handleAddToCart() {
    if (phase.name !== 'confirming') return;
    const selectedRows = phase.results.filter((r) => phase.selections.has(r.displayName));
    const toAdd = selectedRows.map((r) => {
      const opt = phase.selections.get(r.displayName)!;
      const quantity = phase.quantities.get(r.displayName) ?? 1;
      return { productId: opt.productId, displayName: opt.description, quantity };
    });
    // krogerSearchTerm is deduped here since "already carted" tracking is
    // legitimately shared across rows that shop for the same product.
    const addedKrogerTerms = [...new Set(selectedRows.map((r) => r.krogerSearchTerm))];
    setPhase({ name: 'adding' });
    try {
      const result = await addToKrogerCart(toAdd);
      addToCarted(addedKrogerTerms);
      addToPantry(selectedRows.map((r) => ({ name: r.displayName })));
      setPhase({ name: 'done', addedCount: result.added.length, addedTerms: addedKrogerTerms });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add to cart';
      if (message.includes('Not connected') || message.includes('session expired')) disconnect();
      setPhase({ name: 'error', message });
    }
  }

  // ── Modal title / subtitle ─────────────────────────────────────────────────

  let headerTitle = 'Shopping List';
  let headerSub = `${items.length} items · ${checked.size} selected`;

  if (phase.name === 'editing') {
    const cur = phase.results.find((r) => r.displayName === phase.rowKey);
    headerTitle = cur?.displayName ?? 'Choose product';
    const resultsLabel = cur ? `${cur.options.length} ${cur.options.length === 1 ? 'result' : 'results'}` : '';
    headerSub = phase.queue
      ? `Item ${(phase.queueIndex ?? 0) + 1} of ${phase.queue.length}${resultsLabel ? ` · ${resultsLabel}` : ''}`
      : resultsLabel;
  } else if (phase.name === 'confirming') {
    const unconfirmedCount = [...phase.confidence.values()].filter((c) => !c).length;
    headerTitle = 'Review Cart';
    headerSub = `${phase.selections.size} selected · ${phase.notFound.size} not found`
      + (unconfirmedCount > 0 ? ` · ${unconfirmedCount} to verify` : '');
  } else if (phase.name === 'store-picker') {
    headerSub = 'Choose your Kroger store';
  } else if (phase.name === 'done') {
    headerSub = `${phase.addedCount} items added to your Kroger cart`;
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--shopping-list" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">

        {/* Header */}
        <div className="modal__header">
          <div className="modal__title-group">
            <h2 className="modal__title">{headerTitle}</h2>
            <p className="modal__subtitle">{headerSub}</p>
          </div>
          <button className="modal__close" onClick={handleTopClose} aria-label={topCloseLabel}>✕</button>
        </div>

        {/* Progress through the manual-review queue */}
        {phase.name === 'editing' && phase.queue && (
          <div className="review-progress-bar">
            <div
              className="review-progress-bar__fill"
              style={{ width: `${((phase.queueIndex ?? 0) + 1) / phase.queue.length * 100}%` }}
            />
          </div>
        )}

        {/* Body */}
        <div className="shopping-modal__body">

          {/* ── List ── */}
          {(phase.name === 'list' || phase.name === 'searching') && (
            <>
              <div className="shopping-modal__controls">
                <button className="shopping-list__toggle-all" onClick={toggleAll} disabled={nonPantryItems.length === 0}>
                  {allNonPantryChecked ? 'Deselect all' : 'Select all'}
                </button>
                <div className="shopping-modal__selects">
                  <label className="shopping-modal__select-label">
                    Sort
                    <select className="shopping-modal__select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                      <option value="alpha-asc">A → Z</option>
                      <option value="alpha-desc">Z → A</option>
                      <option value="recipes-desc">Most recipes</option>
                      <option value="recipes-asc">Fewest recipes</option>
                    </select>
                  </label>
                  <label className="shopping-modal__select-label">
                    Show
                    <select className="shopping-modal__select" value={filter} onChange={(e) => setFilter(e.target.value as FilterKey)}>
                      <option value="all">All ({items.length})</option>
                      <option value="selected">Selected ({checked.size})</option>
                      <option value="unselected">Unselected ({items.length - checked.size})</option>
                    </select>
                  </label>
                </div>
              </div>
              <ul className="shopping-modal__list">
                {displayItems.map((item, idx) => {
                  const isChecked = checked.has(item.displayName);
                  const isCarted = cartedSet.has(item.krogerSearchTerm);
                  const isPantry = !isCarted && pantryNames.has(canonicalIngredientKey(item.displayName));
                  const prev = idx > 0 ? displayItems[idx - 1] : null;
                  const prevCarted = prev ? cartedSet.has(prev.krogerSearchTerm) : false;
                  const prevPantry = prev ? (!cartedSet.has(prev.krogerSearchTerm) && pantryNames.has(canonicalIngredientKey(prev.displayName))) : false;
                  return (
                    <>
                      {isCarted && !prevCarted && (
                        <li key={`${item.displayName}__cart-divider`} className="shopping-item__section-divider">
                          In Cart
                        </li>
                      )}
                      {isPantry && !prevPantry && (
                        <li key={`${item.displayName}__pantry-divider`} className="shopping-item__section-divider shopping-item__section-divider--pantry">
                          In Pantry
                        </li>
                      )}
                      <li
                        key={item.displayName}
                        className={`shopping-item${!isChecked ? ' shopping-item--unchecked' : ''}`}
                        onClick={() => toggle(item.displayName)}
                      >
                        <span className="shopping-item__checkbox">{isChecked ? '✓' : ''}</span>
                        <span className="shopping-item__name-group">
                          <span className="shopping-item__name">{item.displayName}</span>
                          {(isCarted || isPantry) ? (
                            <button
                              className="shopping-item__move-btn"
                              onClick={(e) => { e.stopPropagation(); moveToList(item); }}
                              title="Move back to list"
                            >
                              → List
                            </button>
                          ) : (
                            <button
                              className="shopping-item__move-btn"
                              onClick={(e) => { e.stopPropagation(); moveToPantry(item); }}
                              title="Move to pantry"
                            >
                              → Pantry
                            </button>
                          )}
                        </span>
                        <span className="shopping-item__qty">{item.estimatedQuantity}</span>
                        {item.usedIn.length > 0 && (
                          <span className="shopping-item__used-in">
                            {item.usedIn.length === 1 ? item.usedIn[0] : `${item.usedIn.length} recipes`}
                          </span>
                        )}
                      </li>
                    </>
                  );
                })}
              </ul>
            </>
          )}

          {/* ── Store picker ── */}
          {phase.name === 'store-picker' && (
            <div className="shopping-modal__store-picker">
              <p className="kroger-store-picker__label">Enter your ZIP code to find your store:</p>
              <div className="kroger-store-picker__row">
                <input
                  className="kroger-store-picker__input"
                  type="text" placeholder="e.g. 90210"
                  value={zip} onChange={(e) => setZip(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearchStores()}
                  maxLength={10} autoFocus
                />
                <button className="kroger-store-picker__search" onClick={handleSearchStores} disabled={storeSearching || !zip.trim()}>
                  {storeSearching ? '…' : 'Search'}
                </button>
              </div>
              {storeError && <p className="kroger-store-picker__error">{storeError}</p>}
              {storeResults.length > 0 && (
                <ul className="kroger-store-list">
                  {storeResults.map((loc) => (
                    <li key={loc.locationId} className="kroger-store-item">
                      <div className="kroger-store-item__info">
                        <span className="kroger-store-item__name">{loc.name}</span>
                        <span className="kroger-store-item__addr">{loc.address}</span>
                      </div>
                      <button className="kroger-store-item__select" onClick={() => handleSelectStore(loc)}>Select</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* ── Editing ── */}
          {phase.name === 'editing' && (() => {
            const cur = phase.results.find((r) => r.displayName === phase.rowKey);
            if (!cur) return null;
            const selectedOpt = phase.selections.get(cur.displayName);
            const shoppingItem = items.find((i) => i.displayName === cur.displayName);
            return (
              <div className="product-browser">
                {shoppingItem && (
                  <div className="product-browser__meta">
                    {shoppingItem.estimatedQuantity && (
                      <span className="product-browser__qty">Need: {shoppingItem.estimatedQuantity}</span>
                    )}
                    {selectedOpt && (phase.quantities.get(cur.displayName) ?? 1) > 1 && (
                      <span className="product-browser__qty">Buying: ×{phase.quantities.get(cur.displayName)}</span>
                    )}
                    {shoppingItem.usedIn.length > 0 && (
                      <span className="product-browser__used-in">
                        Used in: {shoppingItem.usedIn.length <= 3
                          ? shoppingItem.usedIn.join(', ')
                          : `${shoppingItem.usedIn.slice(0, 3).join(', ')} +${shoppingItem.usedIn.length - 3} more`}
                      </span>
                    )}
                  </div>
                )}
                {cur.options.length === 0 ? (
                  <div className="product-browser__empty">
                    No results found at this store for this ingredient.
                  </div>
                ) : (() => {
                  const controlled = applyProductControls(cur.options, cur.krogerSearchTerm);
                  const visibleOptions = showAllCandidates ? controlled : controlled.slice(0, CANDIDATE_CAP);
                  return (
                    <>
                      <div className="product-browser__controls">
                        <label className="product-browser__control-label">
                          Sort
                          <select
                            className="product-browser__select"
                            value={candidateSort}
                            onChange={(e) => setCandidateSort(e.target.value as ProductSortKey)}
                          >
                            <option value="relevance">Most relevant</option>
                            <option value="kroger">Kroger's order</option>
                            <option value="price-asc">Price: low → high</option>
                            <option value="price-desc">Price: high → low</option>
                            <option value="alpha-asc">Name: A → Z</option>
                            <option value="alpha-desc">Name: Z → A</option>
                          </select>
                        </label>
                        <label className="product-browser__control-label">
                          Show
                          <select
                            className="product-browser__select"
                            value={productFilter}
                            onChange={(e) => setProductFilter(e.target.value as ProductFilterKey)}
                          >
                            <option value="all">All ({cur.options.length})</option>
                            <option value="in-stock">In stock</option>
                            <option value="on-sale">On sale</option>
                          </select>
                        </label>
                      </div>
                      {visibleOptions.length === 0 ? (
                        <div className="product-browser__empty">No products match this filter.</div>
                      ) : (
                        <div className="product-browser__grid">
                          {visibleOptions.map((opt) => (
                            <ProductCard
                              key={opt.productId}
                              opt={opt}
                              selected={selectedOpt?.productId === opt.productId}
                              onToggle={() => editSelect(opt)}
                            />
                          ))}
                        </div>
                      )}
                      {!showAllCandidates && controlled.length > CANDIDATE_CAP && (
                        <button className="product-browser__show-all" onClick={() => setShowAllCandidates(true)}>
                          Show all {controlled.length} results
                        </button>
                      )}
                    </>
                  );
                })()}
              </div>
            );
          })()}

          {/* ── Confirming ── */}
          {phase.name === 'confirming' && (() => {
            const eligibleCount = rowsEligibleForVerify().length;
            const reviewableKeys = manualReviewScope !== null
              ? new Set(phase.results.filter((r) => r.options.length > 0).map((r) => r.displayName))
              : null;
            const flaggedKeys = manualReviewScope !== null
              ? new Set(phase.results.filter((r) => r.options.length > 0 && needsVerification(r)).map((r) => r.displayName))
              : null;
            return (
            <div className="shopping-modal__confirming">
              <div className="confirming-list-scroll">
              <ul className="confirming-list">
                {[...phase.results]
                  .sort((a, b) => {
                    const unconfirmed = (r: ProductSearchResult) =>
                      phase.selections.has(r.displayName) && phase.confidence.get(r.displayName) === false;
                    return Number(unconfirmed(b)) - Number(unconfirmed(a));
                  })
                  .map((r) => {
                  const sel = phase.selections.get(r.displayName);
                  const qty = phase.quantities.get(r.displayName) ?? 1;
                  const zeroResults = r.options.length === 0;
                  const claudeRejected = phase.claudeRejected.has(r.displayName);
                  const unconfirmed = !!sel && phase.confidence.get(r.displayName) === false;
                  const pickable = manualReviewScope !== null;
                  return (
                    <li
                      key={r.displayName}
                      className={`confirming-item${!sel ? ' confirming-item--skipped' : ''}${!zeroResults ? ' confirming-item--clickable' : ''}${pickable ? ' confirming-item--pickable' : ''}`}
                      onClick={
                        zeroResults ? undefined
                        : pickable ? () => toggleManualReviewRow(r.displayName)
                        : () => openEditing(r.displayName)
                      }
                    >
                      {pickable && (
                        <span className={`confirming-item__checkbox${manualReviewScope!.has(r.displayName) ? ' confirming-item__checkbox--checked' : ''}`}>
                          {manualReviewScope!.has(r.displayName) ? '✓' : ''}
                        </span>
                      )}
                      <span className="confirming-item__ingredient">
                        {r.displayName}
                        {unconfirmed && (
                          <span className="confirming-item__badge" title="Either no full word match was found, or a cheaper alternative was picked over Kroger's top match for this ingredient — worth a quick check">
                            ⚠ Verify
                          </span>
                        )}
                      </span>
                      {sel ? (
                        <span className="confirming-item__product">
                          {sel.brand && <>{sel.brand} · </>}{sel.description}
                          {qty > 1 && <> · ×{qty}</>}
                          {(sel.promoPrice ?? sel.regularPrice) != null && (
                            <> · ${((sel.promoPrice ?? sel.regularPrice)! * qty).toFixed(2)}</>
                          )}
                        </span>
                      ) : zeroResults ? (
                        <span className="confirming-item__note">Not found at this store</span>
                      ) : claudeRejected ? (
                        <span className="confirming-item__note">Claude found no suitable match</span>
                      ) : (
                        <span className="confirming-item__note">Not selected</span>
                      )}
                      {pickable ? null : zeroResults ? (
                        <a
                          className="confirming-item__change"
                          href={`https://www.kroger.com/search?query=${encodeURIComponent(r.displayName)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                        >
                          Search Kroger ↗
                        </a>
                      ) : (
                        <span className="confirming-item__change">Change</span>
                      )}
                    </li>
                  );
                })}
              </ul>
              </div>

              {manualReviewScope !== null ? (
                <div className="manual-review-bar">
                  <div className="manual-review-bar__row">
                    <button
                      className="btn-secondary"
                      onClick={selectAllReviewable}
                      disabled={setsEqual(manualReviewScope, reviewableKeys!)}
                    >
                      Select all
                    </button>
                    <button
                      className="btn-secondary"
                      onClick={selectFlaggedOnly}
                      disabled={setsEqual(manualReviewScope, flaggedKeys!)}
                    >
                      Flagged only
                    </button>
                    <span className="manual-review-bar__count">{manualReviewScope.size} selected</span>
                  </div>
                  <div className="manual-review-bar__row">
                    <button className="btn-secondary" onClick={() => setManualReviewScope(null)}>Cancel</button>
                    <button className="btn-primary" onClick={beginManualReviewFromScope} disabled={manualReviewScope.size === 0}>
                      Start Review ({manualReviewScope.size})
                    </button>
                  </div>
                </div>
              ) : (
                <div className="review-actions-bar">
                  <button className="btn-secondary" onClick={() => setManualReviewScope(new Set())}>
                    Manually Review Items
                  </button>
                  {!phase.pickedByClaudeDirectly && (
                    <div className={`claude-verify-bar${claudeVerifyUsed ? ' claude-verify-bar--used' : ''}`}>
                      <label className="claude-verify-bar__toggle">
                        <input
                          type="checkbox"
                          checked={checkAllForVerify}
                          disabled={claudeVerifyUsed}
                          onClick={(e) => {
                            if (!hasFullAccess) e.preventDefault();
                          }}
                          onChange={(e) => {
                            if (hasFullAccess) setCheckAllForVerify(e.target.checked);
                          }}
                        />
                        Check all items, not just flagged
                      </label>
                      <button
                        className="btn-secondary claude-verify-bar__btn"
                        onClick={() => {
                          if (!hasFullAccess) { setShowFullAccessModal(true); return; }
                          handleAskClaude();
                        }}
                        disabled={hasFullAccess && (verifying || eligibleCount === 0 || claudeVerifyUsed)}
                        title={
                          !hasFullAccess
                            ? 'Requires Full Access — click to learn more'
                            : claudeVerifyUsed
                              ? 'Already verified for this search — run "Find Products" again to ask again'
                              : 'Sends the ingredient and its candidate products to Claude to pick the best match, or say none are suitable'
                        }
                      >
                        {!hasFullAccess
                          ? `Ask Claude to Verify (Full Access)`
                          : verifying
                            ? 'Asking Claude…'
                            : claudeVerifyUsed
                              ? 'Verified with Claude ✓'
                              : `Ask Claude to Verify (${eligibleCount})`}
                      </button>
                    </div>
                  )}
                  {verifyError && <p className="claude-verify-bar__error">{verifyError}</p>}
                </div>
              )}
            </div>
            );
          })()}

          {/* ── Done / Error ── */}
          {(phase.name === 'done' || phase.name === 'error' || phase.name === 'adding') && (
            <div className="shopping-modal__done">
              {phase.name === 'adding' && (
                <><div className="loading-spinner" /><p>Adding to your Kroger cart…</p></>
              )}
              {phase.name === 'done' && (
                <p className="kroger-cart-result__added">✓ {phase.addedCount} items added to your cart</p>
              )}
              {phase.name === 'error' && (
                <p className="kroger-cart-result__error">{phase.message}</p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="shopping-modal__footer">
          <div className="shopping-modal__footer-status">
            {!isConnected ? (
              <span className="footer-status__text footer-status__text--dim">Kroger · Not connected</span>
            ) : !locationId ? (
              <span className="footer-status__text">Kroger · Connected</span>
            ) : (
              <span className="footer-status__text">
                {locationName}
                {phase.name === 'list' && (
                  <button className="footer-status__change" onClick={() => setPhase({ name: 'store-picker' })}>Change</button>
                )}
              </span>
            )}
          </div>

          <div className="shopping-modal__footer-actions">
            {/* List */}
            {phase.name === 'list' && !isConnected && (
              <button className="btn-primary" onClick={() => window.open('/auth/kroger', '_blank')}>Connect Kroger</button>
            )}
            {phase.name === 'list' && isConnected && !locationId && (
              <button className="btn-primary" onClick={() => setPhase({ name: 'store-picker' })}>Choose Store</button>
            )}
            {phase.name === 'list' && isConnected && locationId && (
              <>
                <label
                  className={`claude-direct-toggle${!hasFullAccess ? ' claude-direct-toggle--locked' : ''}`}
                  title={
                    hasFullAccess
                      ? 'Skip the matching algorithm entirely — send every ingredient straight to Claude to pick a product for, or say no suitable match exists.'
                      : 'Requires Full Access — click to learn more'
                  }
                >
                  <input
                    type="checkbox"
                    checked={claudeDirectMode}
                    onClick={(e) => {
                      if (!hasFullAccess) {
                        e.preventDefault();
                        setShowFullAccessModal(true);
                      }
                    }}
                    onChange={(e) => {
                      if (hasFullAccess) setClaudeDirectMode(e.target.checked);
                    }}
                  />
                  Let Claude pick directly{!hasFullAccess && ' (Full Access)'}
                </label>
                <div
                  className="mode-toggle mode-toggle--compact"
                  role="radiogroup"
                  aria-label="Product match preference"
                  title={
                    claudeDirectMode
                      ? 'Not used when Claude picks directly'
                      : "How to pick among products that already match the ingredient — trust Kroger's top result, or shop across more of them for a lower price"
                  }
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={matchMode === 'accuracy'}
                    className={`mode-toggle__option${matchMode === 'accuracy' ? ' mode-toggle__option--active' : ''}`}
                    onClick={() => setMatchMode('accuracy')}
                    disabled={claudeDirectMode}
                    title="Use Kroger's single best match for each ingredient — no price comparison."
                  >
                    Accurate
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={matchMode === 'balanced'}
                    className={`mode-toggle__option${matchMode === 'balanced' ? ' mode-toggle__option--active' : ''}`}
                    onClick={() => setMatchMode('balanced')}
                    disabled={claudeDirectMode}
                    title="Compare price across a few of the best matches for each ingredient (default)."
                  >
                    Balanced
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={matchMode === 'price'}
                    className={`mode-toggle__option${matchMode === 'price' ? ' mode-toggle__option--active' : ''}`}
                    onClick={() => setMatchMode('price')}
                    disabled={claudeDirectMode}
                    title="Compare price across many matches to find the lowest price for each ingredient."
                  >
                    Cheapest
                  </button>
                </div>
                <button className="btn-primary" onClick={handleFindProducts} disabled={!cartPayload.length}>
                  {claudeDirectMode ? `Find Products with Claude (${cartPayload.length})` : `Find Products (${cartPayload.length})`}
                </button>
              </>
            )}

            {/* Searching */}
            {phase.name === 'searching' && (
              <div className="kroger-cart-section__loading">
                <div className="loading-spinner loading-spinner--sm" />
                <span>Searching {cartPayload.length} items…</span>
              </div>
            )}

            {/* Store picker */}
            {phase.name === 'store-picker' && (
              <button className="btn-secondary" onClick={() => setPhase({ name: 'list' })}>Cancel</button>
            )}

            {/* Editing */}
            {phase.name === 'editing' && (
              <>
                <button
                  className="btn-secondary"
                  onClick={removeEditingSelection}
                  disabled={!phase.selections.has(phase.rowKey)}
                >
                  Remove Selection
                </button>
                {phase.queue ? (
                  <>
                    <button className="btn-secondary" onClick={() => advanceQueue(-1)} disabled={(phase.queueIndex ?? 0) === 0}>
                      ← Back
                    </button>
                    {(phase.queueIndex ?? 0) < phase.queue.length - 1 ? (
                      <button className="btn-primary" onClick={() => advanceQueue(1)}>
                        Next →
                      </button>
                    ) : (
                      <button className="btn-primary" onClick={closeEditing}>
                        Finish Review
                      </button>
                    )}
                  </>
                ) : (
                  <button className="btn-primary" onClick={closeEditing}>
                    Done
                  </button>
                )}
              </>
            )}

            {/* Confirming */}
            {phase.name === 'confirming' && (() => {
              const totalPrice = [...phase.selections.entries()].reduce((sum, [key, opt]) => {
                const price = opt.promoPrice ?? opt.regularPrice;
                if (price == null) return sum;
                const qty = phase.quantities.get(key) ?? 1;
                return sum + price * qty;
              }, 0);
              return (
                <>
                  <button className="btn-secondary" onClick={() => setPhase({ name: 'list' })}>
                    ← Back to List
                  </button>
                  {phase.selections.size > 0 && (
                    <span className="shopping-modal__total">Total: ${totalPrice.toFixed(2)}</span>
                  )}
                  <button className="btn-primary" onClick={handleAddToCart} disabled={phase.selections.size === 0}>
                    Add {phase.selections.size} to Cart
                  </button>
                </>
              );
            })()}

            {/* Done / Error */}
            {(phase.name === 'done' || phase.name === 'error') && (
              <>
                <button className="btn-secondary" onClick={() => setPhase({ name: 'list' })}>Back to List</button>
                <button className="btn-primary" onClick={onClose}>Done</button>
              </>
            )}
          </div>
        </div>
      </div>
      {showFullAccessModal && <FullAccessRequiredModal onClose={() => setShowFullAccessModal(false)} />}
    </div>
  );
}
