import { useEffect } from 'react';
import type { Recipe } from '../../types/mealPlan';
import { useMealPlanStore } from '../../store/useMealPlanStore';
import { exportSingleRecipePDF } from '../../utils/exportMealPlan';

interface Props {
  recipe: Recipe;
  mealType: string;
  onClose: () => void;
}

const MEAL_TYPE_LABELS: Record<string, string> = {
  breakfast: '朝食',
  lunch: '昼食',
  dinner: '夕食',
  snack: '間食',
  'morning snack': '朝の間食',
  'afternoon snack': '午後の間食',
  'evening snack': '夜の間食',
};

export default function Modal({ recipe, mealType, onClose }: Props) {
  const { favorites, toggleFavorite } = useMealPlanStore();
  const isFavorited = favorites.some((f) => f.recipe.id === recipe.id);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  const totalTime = recipe.prepTime + recipe.cookTime;
  const label = MEAL_TYPE_LABELS[mealType] ?? mealType;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">

        <div className="modal__header">
          <div className="modal__title-group">
            <span className="modal__type-badge">{label}</span>
            <h2 className="modal__title">{recipe.name}</h2>
            <div className="modal__subtitle">
              <span>{recipe.cuisine}</span>
              <span className="modal__dot">·</span>
              <span>Prep {recipe.prepTime}m</span>
              <span className="modal__dot">·</span>
              <span>Cook {recipe.cookTime}m</span>
              <span className="modal__dot">·</span>
              <span>{totalTime}m total</span>
              <span className="modal__dot">·</span>
              <span>Serves {recipe.servings}</span>
            </div>
          </div>
          <div className="modal__header-actions">
            <button
              className={`modal__star${isFavorited ? ' modal__star--active' : ''}`}
              onClick={() => toggleFavorite(recipe, mealType)}
              aria-label={isFavorited ? 'Remove from favorites' : 'Save to favorites'}
            >
              {isFavorited ? '★' : '☆'}
            </button>
            <button
              className="modal__print-btn"
              onClick={() => exportSingleRecipePDF(recipe, mealType)}
              aria-label="Print recipe"
              title="Print recipe"
            >
              ⎙
            </button>
            <button className="modal__close" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </div>

        {recipe.imageUrl && (
          <div className="modal__hero">
            <img
              src={`/api/image-proxy?url=${encodeURIComponent(recipe.imageUrl)}`}
              alt={recipe.name}
              className="modal__hero-img"
              onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.display = 'none'; }}
            />
          </div>
        )}

        <div className="modal__body">
          <div className="modal__macros">
            {[
              { label: 'Calories', value: recipe.macros.calories, unit: ' kcal' },
              { label: 'Fat', value: recipe.macros.fats, unit: 'g' },
              { label: 'Sodium', value: recipe.macros.sodium, unit: 'mg' },
              { label: 'Carbs', value: recipe.macros.carbohydrates, unit: 'g' },
              { label: 'Fiber', value: recipe.macros.fiber, unit: 'g' },
              { label: 'Sugar', value: recipe.macros.sugar, unit: 'g' },
              { label: 'Protein', value: recipe.macros.protein, unit: 'g' },
            ].map(({ label, value, unit }) => (
              <div key={label} className="modal__macro-pill">
                <span className="modal__macro-label">{label}</span>
                <span className="modal__macro-value">{value.toLocaleString()}{unit}</span>
              </div>
            ))}
          </div>

          <div className="modal__columns">
            <div className="modal__section">
              <h3 className="modal__section-title">Ingredients</h3>
              <ul className="modal__ingredients">
                {recipe.ingredients.map((ing, i) => (
                  <li key={i}>
                    <span className="modal__ing-qty">{ing.quantity} {ing.unit}</span>
                    <span className="modal__ing-name">{ing.name}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="modal__section">
              <h3 className="modal__section-title">Instructions</h3>
              <ol className="modal__steps">
                {recipe.steps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
            </div>
          </div>

          {recipe.notes && (
            <p className="modal__notes"><strong>Note:</strong> {recipe.notes}</p>
          )}

          {recipe.aiGenerated ? (
            <span className="modal__source modal__source--ai">
              Generated by Claude from its training knowledge — not sourced from the web
            </span>
          ) : (
            <a
              className="modal__source"
              href={recipe.sourceUrl ?? `https://www.google.com/search?q=${encodeURIComponent(`${recipe.name} recipe site:${recipe.sourceSite}`)}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {recipe.sourceUrl ? `View recipe on ${recipe.sourceSite} ↗` : `Search ${recipe.sourceSite} ↗`}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
