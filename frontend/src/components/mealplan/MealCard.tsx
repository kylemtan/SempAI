import { useState } from 'react';
import type { Meal } from '../../types/mealPlan';
import Modal from '../ui/Modal';
import { useMealPlanStore, regenKey } from '../../store/useMealPlanStore';

interface Props {
  meal: Meal;
  day: string;
}

const MEAL_TYPE_LABELS: Record<string, { jp: string; en: string }> = {
  breakfast:        { jp: '朝',  en: 'Breakfast' },
  lunch:            { jp: '昼',  en: 'Lunch' },
  dinner:           { jp: '夕',  en: 'Dinner' },
  snack:            { jp: '間',  en: 'Snack' },
  'morning snack':  { jp: '間朝', en: 'Morning Snack' },
  'afternoon snack':{ jp: '間昼', en: 'Afternoon Snack' },
  'evening snack':  { jp: '間夕', en: 'Evening Snack' },
};

export default function MealCard({ meal, day }: Props) {
  const [open, setOpen] = useState(false);
  const { mealPlan, regenSelection, toggleRegenSelection, recentlyRegenerated, markMealSeen } = useMealPlanStore();
  const { recipe } = meal;
  const totalTime = recipe.prepTime + recipe.cookTime;
  const label = MEAL_TYPE_LABELS[meal.mealType] ?? { jp: meal.mealType, en: meal.mealType };

  const canReplace = !!mealPlan;
  const key = regenKey(day, meal.mealType);
  const isSelected = regenSelection.includes(key);
  const justRegenerated = recentlyRegenerated.includes(key);

  function handleOpen() {
    setOpen(true);
    if (justRegenerated) markMealSeen(day, meal.mealType);
  }

  return (
    <>
      <article
        className={`meal-card${isSelected ? ' meal-card--selected' : ''}${justRegenerated ? ' meal-card--regenerated' : ''}`}
        onClick={handleOpen}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && handleOpen()}
      >
        <div className="meal-card__top">
          <span className="meal-card__type-badge">
            {label.jp} <span className="meal-card__type-en">{label.en}</span>
          </span>
          {canReplace && (
            <button
              className={`meal-card__replace${isSelected ? ' meal-card__replace--active' : ''}`}
              onClick={(e) => { e.stopPropagation(); toggleRegenSelection(day, meal.mealType); }}
              aria-label={isSelected ? 'Deselect for replacement' : 'Select for replacement'}
              title={isSelected ? 'Click to deselect' : 'Replace this meal'}
            >
              ↺
            </button>
          )}
        </div>
        <h3 className="meal-card__name">{recipe.name}</h3>
        <div className="meal-card__meta">
          <span className="meal-card__cuisine">{recipe.cuisine}</span>
          <span className="meal-card__time">{totalTime}m</span>
          <span className="meal-card__calories">{recipe.macros.calories} kcal</span>
        </div>
      </article>

      {open && (
        <Modal recipe={recipe} mealType={meal.mealType} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
