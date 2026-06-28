import { useState } from 'react';
import { useKrogerStore } from '../../store/useKrogerStore';
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
  items: CartPayloadItem[];
}

type Phase =
  | { name: 'idle' }
  | { name: 'searching' }
  | { name: 'selecting'; results: ProductSearchResult[]; selections: Map<string, ProductOption> }
  | { name: 'adding' }
  | { name: 'done'; addedCount: number }
  | { name: 'error'; message: string };

function formatPrice(price: number | null): string {
  if (price === null) return '';
  return `$${price.toFixed(2)}`;
}

function productLabel(opt: ProductOption): string {
  const parts = [opt.brand, opt.description].filter(Boolean);
  const label = parts.join(' ');
  const meta = [opt.size, formatPrice(opt.regularPrice ?? opt.promoPrice)].filter(Boolean).join(' · ');
  return meta ? `${label} · ${meta}` : label;
}

export default function KrogerPanel({ items }: Props) {
  const { isConnected, locationId, locationName, disconnect, setLocation } = useKrogerStore();

  const [zip, setZip] = useState('');
  const [locations, setLocations] = useState<KrogerLocation[]>([]);
  const [searchingStores, setSearchingStores] = useState(false);
  const [storeError, setStoreError] = useState('');
  const [showStoreChange, setShowStoreChange] = useState(false);
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });

  async function handleSearchStores() {
    if (!zip.trim()) return;
    setSearchingStores(true);
    setStoreError('');
    setLocations([]);
    try {
      const results = await searchKrogerLocations(zip.trim());
      if (results.length === 0) setStoreError('No stores found near that ZIP code.');
      setLocations(results);
    } catch (err) {
      setStoreError(err instanceof Error ? err.message : 'Could not find stores.');
    } finally {
      setSearchingStores(false);
    }
  }

  function handleSelectStore(loc: KrogerLocation) {
    setLocation(loc.locationId, `${loc.name} – ${loc.address}`);
    setLocations([]);
    setZip('');
    setShowStoreChange(false);
    setPhase({ name: 'idle' });
  }

  async function handleSearchProducts() {
    if (!locationId || items.length === 0) return;
    setPhase({ name: 'searching' });
    try {
      const results = await searchKrogerProducts(items, locationId);
      // Pre-select first option for each ingredient that has results
      const selections = new Map<string, ProductOption>();
      for (const r of results) {
        if (r.options.length > 0) selections.set(r.krogerSearchTerm, r.options[0]);
      }
      setPhase({ name: 'selecting', results, selections });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Product search failed';
      setPhase({ name: 'error', message });
    }
  }

  function handleToggleOption(krogerSearchTerm: string, opt: ProductOption) {
    if (phase.name !== 'selecting') return;
    const next = new Map(phase.selections);
    const current = next.get(krogerSearchTerm);
    if (current?.productId === opt.productId) {
      next.delete(krogerSearchTerm); // deselect
    } else {
      next.set(krogerSearchTerm, opt); // swap selection
    }
    setPhase({ ...phase, selections: next });
  }

  async function handleAddToCart() {
    if (phase.name !== 'selecting') return;
    const selections = Array.from(phase.selections.entries()).map(([, opt]) => ({
      productId: opt.productId,
      displayName: opt.description,
    }));
    if (selections.length === 0) return;
    setPhase({ name: 'adding' });
    try {
      const result = await addToKrogerCart(selections);
      setPhase({ name: 'done', addedCount: result.added.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add to cart';
      if (message.includes('Not connected') || message.includes('session expired')) {
        await disconnect();
      }
      setPhase({ name: 'error', message });
    }
  }

  function handleDisconnect() {
    disconnect();
    setPhase({ name: 'idle' });
    setLocations([]);
  }

  const showStorePicker = !locationId || showStoreChange;

  // ── Not connected ─────────────────────────────────────────────────────────────
  if (!isConnected) {
    return (
      <div className="kroger-panel kroger-panel--disconnected">
        <p className="kroger-panel__hint">
          Connect your Kroger account to send this list directly to your cart.
        </p>
        <button
          className="btn-primary kroger-panel__connect"
          onClick={() => window.open('/auth/kroger', '_blank')}
        >
          Connect to Kroger
        </button>
      </div>
    );
  }

  // ── Connected ─────────────────────────────────────────────────────────────────
  return (
    <div className="kroger-panel kroger-panel--connected">
      <div className="kroger-panel__header">
        <span className="kroger-panel__status">Kroger connected</span>
        <button className="kroger-panel__disconnect" onClick={handleDisconnect}>
          Disconnect
        </button>
      </div>

      {showStorePicker ? (
        <div className="kroger-store-picker">
          {locationId && (
            <button
              className="kroger-store-picker__cancel"
              onClick={() => { setShowStoreChange(false); setLocations([]); }}
            >
              Cancel
            </button>
          )}
          <p className="kroger-store-picker__label">Enter your ZIP code to find your store:</p>
          <div className="kroger-store-picker__row">
            <input
              className="kroger-store-picker__input"
              type="text"
              placeholder="e.g. 90210"
              value={zip}
              onChange={(e) => setZip(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearchStores()}
              maxLength={10}
            />
            <button
              className="kroger-store-picker__search"
              onClick={handleSearchStores}
              disabled={searchingStores || !zip.trim()}
            >
              {searchingStores ? '…' : 'Search'}
            </button>
          </div>
          {storeError && <p className="kroger-store-picker__error">{storeError}</p>}
          {locations.length > 0 && (
            <ul className="kroger-store-list">
              {locations.map((loc) => (
                <li key={loc.locationId} className="kroger-store-item">
                  <div className="kroger-store-item__info">
                    <span className="kroger-store-item__name">{loc.name}</span>
                    <span className="kroger-store-item__addr">{loc.address}</span>
                  </div>
                  <button className="kroger-store-item__select" onClick={() => handleSelectStore(loc)}>
                    Select
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="kroger-cart-section">
          <div className="kroger-cart-section__store">
            <span className="kroger-cart-section__store-name">{locationName}</span>
            <button
              className="kroger-cart-section__change"
              onClick={() => { setShowStoreChange(true); setPhase({ name: 'idle' }); }}
            >
              Change
            </button>
          </div>

          {/* ── Idle ── */}
          {phase.name === 'idle' && (
            <button
              className="btn-primary kroger-cart-section__add"
              onClick={handleSearchProducts}
              disabled={items.length === 0}
            >
              Find Products ({items.length} items)
            </button>
          )}

          {/* ── Searching ── */}
          {phase.name === 'searching' && (
            <div className="kroger-cart-section__loading">
              <div className="loading-spinner loading-spinner--sm" />
              <span>Searching {items.length} items at this store…</span>
            </div>
          )}

          {/* ── Selecting ── */}
          {phase.name === 'selecting' && (
            <div className="product-selector">
              <div className="product-selector__summary">
                <span>
                  {phase.selections.size} of {phase.results.length} items selected
                  {phase.results.filter((r) => r.options.length === 0).length > 0 && (
                    <> · <span className="product-selector__unavailable-count">
                      {phase.results.filter((r) => r.options.length === 0).length} unavailable
                    </span></>
                  )}
                </span>
                <div className="product-selector__actions">
                  <button
                    className="kroger-cart-section__change"
                    onClick={() => setPhase({ name: 'idle' })}
                  >
                    Reset
                  </button>
                  <button
                    className="btn-primary"
                    onClick={handleAddToCart}
                    disabled={phase.selections.size === 0}
                  >
                    Add {phase.selections.size} to Cart
                  </button>
                </div>
              </div>

              <ul className="product-selector__list">
                {phase.results.map((result) => {
                  const selected = phase.selections.get(result.krogerSearchTerm);
                  return (
                    <li key={result.krogerSearchTerm} className="product-selector__item">
                      <span className="product-selector__ingredient">{result.displayName}</span>
                      {result.options.length === 0 ? (
                        <span className="product-selector__none">Not available at this store</span>
                      ) : (
                        <div className="product-selector__options">
                          {result.options.map((opt) => (
                            <button
                              key={opt.productId}
                              className={`product-option ${selected?.productId === opt.productId ? 'product-option--selected' : ''}`}
                              onClick={() => handleToggleOption(result.krogerSearchTerm, opt)}
                              title={productLabel(opt)}
                            >
                              {productLabel(opt)}
                            </button>
                          ))}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* ── Adding ── */}
          {phase.name === 'adding' && (
            <div className="kroger-cart-section__loading">
              <div className="loading-spinner loading-spinner--sm" />
              <span>Adding to your Kroger cart…</span>
            </div>
          )}

          {/* ── Done ── */}
          {phase.name === 'done' && (
            <div className="kroger-cart-result">
              <p className="kroger-cart-result__added">
                ✓ {phase.addedCount} item{phase.addedCount !== 1 ? 's' : ''} added to your cart
              </p>
              <button className="kroger-cart-result__again" onClick={() => setPhase({ name: 'idle' })}>
                Search again
              </button>
            </div>
          )}

          {/* ── Error ── */}
          {phase.name === 'error' && (
            <div className="kroger-cart-result">
              <p className="kroger-cart-result__error">{phase.message}</p>
              <button className="kroger-cart-result__again" onClick={() => setPhase({ name: 'idle' })}>
                Retry
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
