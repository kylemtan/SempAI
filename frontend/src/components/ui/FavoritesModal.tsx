import { useEffect, useState } from 'react';
import { useMealPlanStore, type FavoriteEntry } from '../../store/useMealPlanStore';
import Modal from './Modal';

interface Props {
  onClose: () => void;
}

const MEAL_TYPE_LABELS: Record<string, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snack: 'Snack',
  'morning snack': 'Morning Snack',
  'afternoon snack': 'Afternoon Snack',
  'evening snack': 'Evening Snack',
};

function FavoriteRow({ entry, isPinned, onPin, onRemove, onView }: {
  entry: FavoriteEntry;
  isPinned: boolean;
  onPin: () => void;
  onRemove: () => void;
  onView: () => void;
}) {
  return (
    <li className="favorite-item">
      <button className="favorite-item__info" onClick={onView} title="View full recipe">
        <span className="favorite-item__name">{entry.recipe.name}</span>
        <span className="favorite-item__meta">
          {MEAL_TYPE_LABELS[entry.mealType] ?? entry.mealType} · {entry.recipe.cuisine}
        </span>
      </button>
      <div className="favorite-item__actions">
        <button
          className={`favorite-item__pin${isPinned ? ' favorite-item__pin--active' : ''}`}
          onClick={onPin}
          title={isPinned ? 'Remove from next plan' : 'Include in next plan'}
        >
          {isPinned ? 'Pinned ★' : 'Pin ☆'}
        </button>
        <button
          className="favorite-item__remove"
          onClick={onRemove}
          aria-label={`Remove ${entry.recipe.name} from favorites`}
        >
          ✕
        </button>
      </div>
    </li>
  );
}

export default function FavoritesModal({ onClose }: Props) {
  const { favorites, pinnedFavoriteIds, removeFavorite, togglePinFavorite } = useMealPlanStore();
  const [viewing, setViewing] = useState<FavoriteEntry | null>(null);

  const sorted = [...favorites].sort((a, b) => b.savedAt - a.savedAt);
  const pinnedCount = pinnedFavoriteIds.filter((id) => favorites.some((f) => f.recipe.id === id)).length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return (
    <>
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal modal--blacklist"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Saved recipes"
      >
        <div className="modal__header">
          <div className="modal__title-group">
            <h2 className="modal__title">Saved Recipes</h2>
            <p className="modal__subtitle">
              {favorites.length === 0
                ? 'Star recipes in the plan to save them here.'
                : pinnedCount > 0
                  ? `${pinnedCount} pinned — will appear in your next generated plan.`
                  : 'Pin recipes to include them in your next plan.'}
            </p>
          </div>
          <button className="modal__close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="modal__body">
          {favorites.length === 0 ? (
            <p className="blacklist-empty">
              Open any recipe and click ☆ to save it here. Pinned recipes are included when you generate a new plan.
            </p>
          ) : (
            <ul className="blacklist-list">
              {sorted.map((entry) => (
                <FavoriteRow
                  key={entry.recipe.id}
                  entry={entry}
                  isPinned={pinnedFavoriteIds.includes(entry.recipe.id)}
                  onPin={() => togglePinFavorite(entry.recipe.id)}
                  onRemove={() => removeFavorite(entry.recipe.id)}
                  onView={() => setViewing(entry)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>

    {viewing && (
      <Modal
        recipe={viewing.recipe}
        mealType={viewing.mealType}
        onClose={() => setViewing(null)}
      />
    )}
  </>
  );
}
