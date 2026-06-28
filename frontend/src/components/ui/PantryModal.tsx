import { useEffect, useRef, useState, useMemo } from 'react';
import { usePantryStore } from '../../store/usePantryStore';
import {
  INGREDIENT_SUGGESTIONS,
  PANTRY_CATEGORIES,
  detectCategory,
  type PantryCategory,
} from '../../data/pantryData';

interface Props {
  onClose: () => void;
}

export default function PantryModal({ onClose }: Props) {
  const { pantry, addToPantry, removeFromPantry, clearPantry } = usePantryStore();
  const [query, setQuery] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [highlightedIdx, setHighlightedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (dropdownOpen) { setDropdownOpen(false); } else { onClose(); } } };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    inputRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose, dropdownOpen]);

  const pantryNameSet = useMemo(
    () => new Set(pantry.map((p) => p.name.toLowerCase().trim())),
    [pantry]
  );

  const suggestions = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return [];
    return INGREDIENT_SUGGESTIONS
      .filter((s) => s.name.toLowerCase().includes(q) && !pantryNameSet.has(s.name.toLowerCase()))
      .slice(0, 8);
  }, [query, pantryNameSet]);

  useEffect(() => {
    setHighlightedIdx(0);
    setDropdownOpen(suggestions.length > 0);
  }, [suggestions]);

  function addItem(name: string, category?: PantryCategory) {
    const trimmed = name.trim();
    if (!trimmed) return;
    addToPantry([{ name: trimmed, category: category ?? detectCategory(trimmed) }]);
    setQuery('');
    setDropdownOpen(false);
    inputRef.current?.focus();
  }

  function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIdx((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (dropdownOpen && suggestions[highlightedIdx]) {
        const s = suggestions[highlightedIdx];
        addItem(s.name, s.category);
      } else if (query.trim()) {
        addItem(query);
      }
    }
  }

  const byCategory = useMemo(() => {
    const map = new Map<PantryCategory, typeof pantry>();
    for (const cat of PANTRY_CATEGORIES) map.set(cat, []);
    for (const item of pantry) {
      const cat = (item.category ?? 'Other') as PantryCategory;
      map.get(cat)?.push(item);
    }
    return map;
  }, [pantry]);

  const populatedCategories = PANTRY_CATEGORIES.filter(
    (cat) => (byCategory.get(cat)?.length ?? 0) > 0
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal modal--pantry"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Pantry"
      >
        <div className="modal__header">
          <div className="modal__title-group">
            <h2 className="modal__title">Pantry</h2>
            <p className="modal__subtitle">
              {pantry.length === 0
                ? 'Track ingredients you already have — they\'ll be separated in your shopping list.'
                : `${pantry.length} ingredient${pantry.length === 1 ? '' : 's'} on hand`}
            </p>
          </div>
          <button className="modal__close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="pantry-search-bar">
          <div className="pantry-search-bar__input-wrap" ref={dropdownRef}>
            <input
              ref={inputRef}
              className="pantry-search-bar__input"
              type="text"
              placeholder="Search or type an ingredient and press Enter…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleInputKeyDown}
              onFocus={() => suggestions.length > 0 && setDropdownOpen(true)}
              onBlur={() => setTimeout(() => setDropdownOpen(false), 150)}
              autoComplete="off"
            />
            {dropdownOpen && suggestions.length > 0 && (
              <ul className="pantry-search-bar__dropdown">
                {suggestions.map((s, i) => (
                  <li
                    key={s.name}
                    className={`pantry-search-bar__option${i === highlightedIdx ? ' pantry-search-bar__option--active' : ''}`}
                    onMouseDown={() => addItem(s.name, s.category)}
                    onMouseEnter={() => setHighlightedIdx(i)}
                  >
                    <span className="pantry-search-bar__option-name">{s.name}</span>
                    <span className="pantry-search-bar__option-cat">{s.category}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {query.trim() && !suggestions.some((s) => s.name.toLowerCase() === query.toLowerCase().trim()) && (
            <button className="pantry-search-bar__add-btn" onClick={() => addItem(query)}>
              Add "{query.trim()}"
            </button>
          )}
        </div>

        <div className="modal__body pantry-modal__body">
          {pantry.length === 0 ? (
            <p className="pantry-empty">
              Start typing above to search common ingredients, or type anything and press Enter to add it.
            </p>
          ) : (
            <>
              <div className="pantry-grid">
                {populatedCategories.map((cat) => {
                  const items = byCategory.get(cat) ?? [];
                  if (!items.length) return null;
                  return (
                    <div key={cat} className="pantry-category">
                      <h3 className="pantry-category__title">{cat}</h3>
                      <div className="pantry-category__chips">
                        {items
                          .sort((a, b) => a.name.localeCompare(b.name))
                          .map((item) => (
                            <span key={item.name} className="pantry-chip">
                              {item.name}
                              <button
                                className="pantry-chip__remove"
                                onClick={() => removeFromPantry(item.name)}
                                aria-label={`Remove ${item.name}`}
                              >
                                ✕
                              </button>
                            </span>
                          ))}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="pantry-footer">
                <button className="blacklist-clear" onClick={clearPantry}>
                  Clear All
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
