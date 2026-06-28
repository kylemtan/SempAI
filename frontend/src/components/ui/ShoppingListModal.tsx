import { useState, useEffect, useMemo } from 'react';
import type { ShoppingItem } from '../../types/mealPlan';
import { useKrogerStore } from '../../store/useKrogerStore';
import { useMealPlanStore } from '../../store/useMealPlanStore';
import { usePantryStore } from '../../store/usePantryStore';
import {
  searchKrogerLocations,
  searchKrogerProducts,
  addToKrogerCart,
  type CartPayloadItem,
  type ProductOption,
  type ProductSearchResult,
  type KrogerLocation,
} from '../../services/krogerApi';

interface Props {
  items: ShoppingItem[];
  onClose: () => void;
}

type SortKey = 'alpha-asc' | 'alpha-desc' | 'recipes-desc' | 'recipes-asc';
type FilterKey = 'all' | 'selected' | 'unselected';
type ProductSortKey = 'price-asc' | 'price-desc' | 'alpha-asc' | 'alpha-desc';
type ProductFilterKey = 'all' | 'in-stock' | 'on-sale';

type Phase =
  | { name: 'list' }
  | { name: 'store-picker' }
  | { name: 'searching' }
  | { name: 'browsing'; results: ProductSearchResult[]; selections: Map<string, ProductOption>; skipped: Set<string>; index: number }
  | { name: 'confirming'; results: ProductSearchResult[]; selections: Map<string, ProductOption>; skipped: Set<string> }
  | { name: 'adding' }
  | { name: 'done'; addedCount: number; addedTerms: string[] }
  | { name: 'error'; message: string };

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

export default function ShoppingListModal({ items, onClose }: Props) {
  const { isConnected, locationId, locationName, setLocation, disconnect } = useKrogerStore();
  const { cartedTerms, addToCarted, removeFromCarted } = useMealPlanStore();
  const { pantry, addToPantry, removeFromPantry } = usePantryStore();

  const [checked, setChecked] = useState<Set<string>>(() => {
    const carted = new Set(useMealPlanStore.getState().cartedTerms);
    const pantryNames = new Set(
      usePantryStore.getState().pantry.map((p) => p.name.toLowerCase().trim())
    );
    return new Set(
      items
        .filter((i) =>
          !carted.has(i.krogerSearchTerm) &&
          !pantryNames.has(i.displayName.toLowerCase().trim())
        )
        .map((i) => i.krogerSearchTerm)
    );
  });
  const [sort, setSort] = useState<SortKey>('alpha-asc');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [phase, setPhase] = useState<Phase>({ name: 'list' });
  const [productSort, setProductSort] = useState<ProductSortKey>('price-asc');
  const [productFilter, setProductFilter] = useState<ProductFilterKey>('all');

  // Reset product sort/filter when navigating to a different ingredient
  useEffect(() => {
    if (phase.name === 'browsing') {
      setProductSort('price-asc');
      setProductFilter('all');
    }
  }, [phase.name === 'browsing' ? phase.index : null]); // eslint-disable-line react-hooks/exhaustive-deps

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
    setChecked((p) => p.size === items.length ? new Set() : new Set(items.map((i) => i.krogerSearchTerm)));
  }

  function moveToList(item: ShoppingItem) {
    removeFromCarted(item.krogerSearchTerm);
    removeFromPantry(item.displayName);
    setChecked((p) => { const n = new Set(p); n.add(item.krogerSearchTerm); return n; });
  }

  function moveToPantry(item: ShoppingItem) {
    addToPantry([{ name: item.displayName }]);
    setChecked((p) => { const n = new Set(p); n.delete(item.krogerSearchTerm); return n; });
  }

  // ── Sorted + filtered list ─────────────────────────────────────────────────

  const pantryNames = useMemo(
    () => new Set(pantry.map((p) => p.name.toLowerCase().trim())),
    [pantry]
  );

  const displayItems = useMemo(() => {
    let list = [...items];
    if (filter === 'selected')   list = list.filter((i) => checked.has(i.krogerSearchTerm));
    if (filter === 'unselected') list = list.filter((i) => !checked.has(i.krogerSearchTerm));
    list.sort((a, b) => {
      const tier = (i: ShoppingItem) => {
        if (cartedTerms.includes(i.krogerSearchTerm)) return 1;
        if (pantryNames.has(i.displayName.toLowerCase().trim())) return 2;
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
    .filter((i) => checked.has(i.krogerSearchTerm))
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
    try {
      const results = await searchKrogerProducts(cartPayload, locationId);
      const selections = new Map<string, ProductOption>();
      for (const r of results) {
        if (r.options.length > 0) selections.set(r.krogerSearchTerm, r.options[0]);
      }
      setPhase({ name: 'browsing', results, selections, skipped: new Set(), index: 0 });
    } catch (err) {
      setPhase({ name: 'error', message: err instanceof Error ? err.message : 'Search failed' });
    }
  }

  // ── Product sort/filter ────────────────────────────────────────────────────

  function applyProductControls(opts: ProductOption[]): ProductOption[] {
    let list = [...opts];
    if (productFilter === 'in-stock') list = list.filter((o) => o.stockLevel !== 'TEMPORARILY_OUT_OF_STOCK');
    if (productFilter === 'on-sale')  list = list.filter((o) => o.promoPrice !== null && o.regularPrice !== null && o.promoPrice < o.regularPrice);
    list.sort((a, b) => {
      if (productSort === 'price-asc')  return (a.promoPrice ?? a.regularPrice ?? Infinity) - (b.promoPrice ?? b.regularPrice ?? Infinity);
      if (productSort === 'price-desc') return (b.promoPrice ?? b.regularPrice ?? -Infinity) - (a.promoPrice ?? a.regularPrice ?? -Infinity);
      if (productSort === 'alpha-asc')  return a.description.localeCompare(b.description);
      if (productSort === 'alpha-desc') return b.description.localeCompare(a.description);
      return 0;
    });
    return list;
  }

  // ── Browsing navigation ────────────────────────────────────────────────────

  function browsingSelect(key: string, opt: ProductOption) {
    if (phase.name !== 'browsing') return;
    const next = new Map(phase.selections);
    next.get(key)?.productId === opt.productId ? next.delete(key) : next.set(key, opt);
    setPhase({ ...phase, selections: next });
  }

  function browsingAdvance(skip = false) {
    if (phase.name !== 'browsing') return;
    const { results, selections, skipped, index } = phase;
    const current = results[index];
    const newSkipped = new Set(skipped);
    const newSelections = new Map(selections);
    if (skip) {
      newSkipped.add(current.krogerSearchTerm);
      newSelections.delete(current.krogerSearchTerm);
    }
    const nextIndex = index + 1;
    if (nextIndex >= results.length) {
      setPhase({ name: 'confirming', results, selections: newSelections, skipped: newSkipped });
    } else {
      setPhase({ ...phase, selections: newSelections, skipped: newSkipped, index: nextIndex });
    }
  }

  function browsingBack() {
    if (phase.name !== 'browsing' || phase.index === 0) return;
    setPhase({ ...phase, index: phase.index - 1 });
  }

  // ── Cart add ───────────────────────────────────────────────────────────────

  async function handleAddToCart() {
    if (phase.name !== 'confirming') return;
    const toAdd = Array.from(phase.selections.values()).map((opt) => ({
      productId: opt.productId,
      displayName: opt.description,
    }));
    const addedTerms = Array.from(phase.selections.keys());
    setPhase({ name: 'adding' });
    try {
      const result = await addToKrogerCart(toAdd);
      addToCarted(addedTerms);
      const addedDisplayNames = items
        .filter((i) => addedTerms.includes(i.krogerSearchTerm))
        .map((i) => ({ name: i.displayName }));
      addToPantry(addedDisplayNames);
      setPhase({ name: 'done', addedCount: result.added.length, addedTerms });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add to cart';
      if (message.includes('Not connected') || message.includes('session expired')) disconnect();
      setPhase({ name: 'error', message });
    }
  }

  // ── Modal title / subtitle ─────────────────────────────────────────────────

  let headerTitle = 'Shopping List';
  let headerSub = `${items.length} items · ${checked.size} selected`;

  if (phase.name === 'browsing') {
    const cur = phase.results[phase.index];
    headerTitle = cur.displayName;
    headerSub = `${phase.index + 1} of ${phase.results.length} ingredients · ${cur.options.length} ${cur.options.length === 1 ? 'result' : 'results'}`;
  } else if (phase.name === 'confirming') {
    headerTitle = 'Review Cart';
    headerSub = `${phase.selections.size} items selected · ${phase.skipped.size} skipped`;
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
          <button className="modal__close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {/* Progress bar for browsing */}
        {phase.name === 'browsing' && (
          <div className="browsing-progress">
            <div
              className="browsing-progress__fill"
              style={{ width: `${((phase.index + 1) / phase.results.length) * 100}%` }}
            />
          </div>
        )}

        {/* Body */}
        <div className="shopping-modal__body">

          {/* ── List ── */}
          {(phase.name === 'list' || phase.name === 'searching') && (
            <>
              <div className="shopping-modal__controls">
                <button className="shopping-list__toggle-all" onClick={toggleAll}>
                  {checked.size === items.length ? 'Deselect all' : 'Select all'}
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
                  const isChecked = checked.has(item.krogerSearchTerm);
                  const isCarted = cartedSet.has(item.krogerSearchTerm);
                  const isPantry = !isCarted && pantryNames.has(item.displayName.toLowerCase().trim());
                  const prev = idx > 0 ? displayItems[idx - 1] : null;
                  const prevCarted = prev ? cartedSet.has(prev.krogerSearchTerm) : false;
                  const prevPantry = prev ? (!cartedSet.has(prev.krogerSearchTerm) && pantryNames.has(prev.displayName.toLowerCase().trim())) : false;
                  return (
                    <>
                      {isCarted && !prevCarted && (
                        <li key={`${item.krogerSearchTerm}__cart-divider`} className="shopping-item__section-divider">
                          In Cart
                        </li>
                      )}
                      {isPantry && !prevPantry && (
                        <li key={`${item.krogerSearchTerm}__pantry-divider`} className="shopping-item__section-divider shopping-item__section-divider--pantry">
                          In Pantry
                        </li>
                      )}
                      <li
                        key={item.krogerSearchTerm}
                        className={`shopping-item${!isChecked ? ' shopping-item--unchecked' : ''}`}
                        onClick={() => toggle(item.krogerSearchTerm)}
                      >
                        <span className="shopping-item__checkbox">{isChecked ? '✓' : ''}</span>
                        <span className="shopping-item__name">{item.displayName}</span>
                        <span className="shopping-item__qty">{item.estimatedQuantity}</span>
                        {item.usedIn.length > 0 && (
                          <span className="shopping-item__used-in">
                            {item.usedIn.length === 1 ? item.usedIn[0] : `${item.usedIn.length} recipes`}
                          </span>
                        )}
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

          {/* ── Browsing ── */}
          {phase.name === 'browsing' && (() => {
            const cur = phase.results[phase.index];
            const selectedOpt = phase.selections.get(cur.krogerSearchTerm);
            const shoppingItem = items.find((i) => i.krogerSearchTerm === cur.krogerSearchTerm);
            return (
              <div className="product-browser">
                {shoppingItem && (
                  <div className="product-browser__meta">
                    {shoppingItem.estimatedQuantity && (
                      <span className="product-browser__qty">Need: {shoppingItem.estimatedQuantity}</span>
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
                  const visibleOptions = applyProductControls(cur.options);
                  return (
                    <>
                      <div className="product-browser__controls">
                        <label className="product-browser__control-label">
                          Sort
                          <select
                            className="product-browser__select"
                            value={productSort}
                            onChange={(e) => setProductSort(e.target.value as ProductSortKey)}
                          >
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
                              onToggle={() => browsingSelect(cur.krogerSearchTerm, opt)}
                            />
                          ))}
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            );
          })()}

          {/* ── Confirming ── */}
          {phase.name === 'confirming' && (
            <div className="shopping-modal__confirming">
              <ul className="confirming-list">
                {phase.results.map((r) => {
                  const sel = phase.selections.get(r.krogerSearchTerm);
                  const skip = phase.skipped.has(r.krogerSearchTerm);
                  return (
                    <li key={r.krogerSearchTerm} className={`confirming-item${!sel || skip ? ' confirming-item--skipped' : ''}`}>
                      <span className="confirming-item__ingredient">{r.displayName}</span>
                      {sel && !skip ? (
                        <span className="confirming-item__product">
                          {sel.brand && <>{sel.brand} · </>}{sel.description}
                          {(sel.promoPrice ?? sel.regularPrice) != null && (
                            <> · ${(sel.promoPrice ?? sel.regularPrice)!.toFixed(2)}</>
                          )}
                        </span>
                      ) : r.options.length === 0 ? (
                        <span className="confirming-item__note">Not available at store</span>
                      ) : (
                        <span className="confirming-item__note">Skipped</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

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
              <button className="btn-primary" onClick={handleFindProducts} disabled={!cartPayload.length}>
                Find Products ({cartPayload.length})
              </button>
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

            {/* Browsing */}
            {phase.name === 'browsing' && (() => {
              const cur = phase.results[phase.index];
              const sel = phase.selections.get(cur.krogerSearchTerm);
              const isLast = phase.index === phase.results.length - 1;
              return (
                <>
                  <button
                    className="btn-secondary"
                    onClick={() => browsingAdvance(true)}
                  >
                    Skip
                  </button>
                  <button
                    className="btn-secondary"
                    onClick={browsingBack}
                    disabled={phase.index === 0}
                  >
                    ← Prev
                  </button>
                  <button className="btn-primary" onClick={() => browsingAdvance(false)}>
                    {isLast ? 'Review →' : sel ? 'Confirm & Next →' : 'Next →'}
                  </button>
                </>
              );
            })()}

            {/* Confirming */}
            {phase.name === 'confirming' && (
              <>
                <button className="btn-secondary" onClick={() => {
                  // Return to browsing at last item so they can revise
                  if (phase.results.length > 0) {
                    setPhase({ name: 'browsing', results: phase.results, selections: phase.selections, skipped: phase.skipped, index: phase.results.length - 1 });
                  }
                }}>
                  ← Back
                </button>
                <button className="btn-primary" onClick={handleAddToCart} disabled={phase.selections.size === 0}>
                  Add {phase.selections.size} to Cart
                </button>
              </>
            )}

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
    </div>
  );
}
