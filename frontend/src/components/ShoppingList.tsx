import { useState, useEffect } from 'react';
import type { ShoppingItem } from '../types/mealPlan';
import { useMealPlanStore } from '../store/useMealPlanStore';
import KrogerPanel from './kroger/KrogerPanel';

interface Props {
  items: ShoppingItem[];
}

export default function ShoppingList({ items }: Props) {
  const shoppingListStale = useMealPlanStore((s) => s.shoppingListStale);

  // All checked by default
  const [checked, setChecked] = useState<Set<string>>(() => new Set(items.map((i) => i.krogerSearchTerm)));
  const [collapsed, setCollapsed] = useState(false);

  // Re-sync when items change (new plan generated)
  useEffect(() => {
    setChecked(new Set(items.map((i) => i.krogerSearchTerm)));
  }, [items]);

  function toggle(key: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  function toggleAll() {
    setChecked((prev) =>
      prev.size === items.length ? new Set() : new Set(items.map((i) => i.krogerSearchTerm))
    );
  }

  const selectedItems = items.filter((i) => checked.has(i.krogerSearchTerm));
  const cartPayload = selectedItems.map((i) => ({
    krogerSearchTerm: i.krogerSearchTerm,
    displayName: i.displayName,
  }));

  return (
    <section className="shopping-list">
      <div className="shopping-list__header" onClick={() => setCollapsed((v) => !v)}>
        <div className="shopping-list__title-row">
          <h2 className="shopping-list__title">Shopping List</h2>
          <span className="shopping-list__count">{items.length} items</span>
          {shoppingListStale && (
            <span className="shopping-list__stale">may be outdated after replacements</span>
          )}
        </div>
        <span className="shopping-list__chevron">{collapsed ? '›' : '‹'}</span>
      </div>

      {!collapsed && (
        <>
          <div className="shopping-list__controls">
            <button className="shopping-list__toggle-all" onClick={toggleAll}>
              {checked.size === items.length ? 'Deselect all' : 'Select all'}
            </button>
            <span className="shopping-list__selected-count">
              {checked.size} of {items.length} selected
            </span>
          </div>

          <ul className="shopping-list__items">
            {items.map((item) => (
              <li
                key={item.krogerSearchTerm}
                className={`shopping-item ${!checked.has(item.krogerSearchTerm) ? 'shopping-item--unchecked' : ''}`}
                onClick={() => toggle(item.krogerSearchTerm)}
              >
                <span className="shopping-item__checkbox">
                  {checked.has(item.krogerSearchTerm) ? '✓' : ''}
                </span>
                <span className="shopping-item__name">{item.displayName}</span>
                <span className="shopping-item__qty">{item.estimatedQuantity}</span>
                {item.usedIn.length > 0 && (
                  <span className="shopping-item__used-in">
                    {item.usedIn.length === 1
                      ? item.usedIn[0]
                      : `${item.usedIn.length} recipes`}
                  </span>
                )}
              </li>
            ))}
          </ul>

          <KrogerPanel items={cartPayload} />
        </>
      )}
    </section>
  );
}
