import { useState, useRef, useEffect, useCallback } from 'react';
import {
  usePreferencesStore,
  todayISO,
  addDaysISO,
  CUISINES,
  EQUIPMENT,
  ALLERGENS,
} from '../store/usePreferencesStore';
import { useMealPlanStore } from '../store/useMealPlanStore';
import { useUsageStore } from '../store/useUsageStore';
import CheckboxGroup from './sidebar/CheckboxGroup';
import RangeSlider from './sidebar/RangeSlider';

function timeUntil(ms: number): string {
  const diff = Math.max(0, ms - Date.now());
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return 'less than a minute';
}

function DateRangePicker() {
  const { startDate, numDays, set } = usePreferencesStore();
  const today = todayISO();
  const resolvedStart = startDate || today;
  const endDate = addDaysISO(resolvedStart, numDays - 1);

  function handleStartChange(val: string) {
    if (!val) return;
    set({ startDate: val });
  }

  function handleEndChange(val: string) {
    if (!val) return;
    const [sy, sm, sd] = resolvedStart.split('-').map(Number);
    const [ey, em, ed] = val.split('-').map(Number);
    const diffMs = new Date(ey, em - 1, ed).getTime() - new Date(sy, sm - 1, sd).getTime();
    const diff = Math.round(diffMs / 86400000) + 1;
    set({ numDays: Math.min(7, Math.max(1, diff)) });
  }

  const maxEnd = addDaysISO(resolvedStart, 6);
  const label = numDays === 1 ? '1 day' : `${numDays} days`;

  return (
    <div className="date-range-picker">
      <div className="date-range-picker__row">
        <label className="date-range-picker__label">
          From
          <input
            type="date"
            className="date-range-picker__input"
            value={resolvedStart}
            min={today}
            onChange={(e) => handleStartChange(e.target.value)}
          />
        </label>
        <label className="date-range-picker__label">
          To
          <input
            type="date"
            className="date-range-picker__input"
            value={endDate}
            min={resolvedStart}
            max={maxEnd}
            onChange={(e) => handleEndChange(e.target.value)}
          />
        </label>
      </div>
      <span className="date-range-picker__summary">{label}</span>
    </div>
  );
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export default function Sidebar({ isOpen, onClose }: Props) {
  const prefs = usePreferencesStore();
  const { generate, isLoading } = useMealPlanStore();
  const usage = useUsageStore();

  const scrollRef = useRef<HTMLDivElement>(null);
  const [thumbTop, setThumbTop] = useState(0);
  const [thumbHeight, setThumbHeight] = useState(0);
  const [scrollable, setScrollable] = useState(false);

  const syncScrollbar = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ratio = el.clientHeight / el.scrollHeight;
    setScrollable(ratio < 1);
    setThumbHeight(el.clientHeight * ratio);
    setThumbTop(el.scrollTop * ratio);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    syncScrollbar();
    el.addEventListener('scroll', syncScrollbar, { passive: true });
    const ro = new ResizeObserver(syncScrollbar);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', syncScrollbar); ro.disconnect(); };
  }, [syncScrollbar]);

  return (
    <aside className={`sidebar${isOpen ? ' sidebar--open' : ''}`} data-tour="sidebar">
      <div ref={scrollRef} className="sidebar__scroll">
      <div className="sidebar__header">
        <h1 className="sidebar__title">Preferences</h1>
        <button className="sidebar__close" aria-label="Close menu" onClick={onClose}>✕</button>
      </div>

      <div className="sidebar-section">
        <span className="sidebar-section__label">Recipe Search</span>
        <div className="mode-toggle" role="radiogroup" aria-label="Recipe search method">
          <button
            type="button"
            role="radio"
            aria-checked={prefs.searchMode === 'web'}
            className={`mode-toggle__option${prefs.searchMode === 'web' ? ' mode-toggle__option--active' : ''}`}
            onClick={() => prefs.set({ searchMode: 'web' })}
          >
            Web Search
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={prefs.searchMode === 'training'}
            className={`mode-toggle__option${prefs.searchMode === 'training' ? ' mode-toggle__option--active' : ''}`}
            onClick={() => prefs.set({ searchMode: 'training' })}
          >
            AI Generated
          </button>
        </div>
        <span className="mode-toggle__hint">
          {prefs.searchMode === 'web'
            ? 'Finds real recipes from cooking sites.'
            : "Claude invents recipes from its own training — faster, but not sourced from the web."}
        </span>
      </div>

      <div className="sidebar-section">
        <span className="sidebar-section__label">Date Range</span>
        <DateRangePicker />
      </div>

      <div className="sidebar-section">
        <span className="sidebar-section__label">Meals per Day</span>
        <div className="meals-stepper">
          <button
            className="meals-stepper__btn"
            onClick={() => prefs.set({ mealsPerDay: Math.max(1, prefs.mealsPerDay - 1) })}
            disabled={prefs.mealsPerDay <= 1}
          >−</button>
          <span className="meals-stepper__value">{prefs.mealsPerDay}</span>
          <button
            className="meals-stepper__btn"
            onClick={() => prefs.set({ mealsPerDay: Math.min(6, prefs.mealsPerDay + 1) })}
            disabled={prefs.mealsPerDay >= 6}
          >+</button>
        </div>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section__header">
          <span className="sidebar-section__label">Cuisine</span>
          <button
            className="shopping-list__toggle-all"
            onClick={() => prefs.set({ cuisines: prefs.cuisines.length === CUISINES.length ? [] : CUISINES })}
          >
            {prefs.cuisines.length === CUISINES.length ? 'Deselect all' : 'Select all'}
          </button>
        </div>
        <CheckboxGroup
          options={CUISINES}
          selected={prefs.cuisines}
          onToggle={prefs.toggleCuisine}
        />
      </div>

      <div className="sidebar-section">
        <span className="sidebar-section__label">Equipment</span>
        <CheckboxGroup
          options={EQUIPMENT}
          selected={prefs.equipment}
          onToggle={prefs.toggleEquipment}
        />
      </div>

      <div className="sidebar-section">
        <span className="sidebar-section__label">Macros</span>
        <RangeSlider
          label="Calories"
          value={prefs.macros.maxCalories}
          min={1000} max={5000} step={50} unit=" kcal"
          onChange={(v) => prefs.setMacro('maxCalories', v)}
        />
        <RangeSlider
          label="Carbohydrates"
          value={prefs.macros.maxCarbs}
          min={0} max={600} step={5} unit="g"
          onChange={(v) => prefs.setMacro('maxCarbs', v)}
        />
        <RangeSlider
          label="Fats"
          value={prefs.macros.maxFats}
          min={0} max={250} step={5} unit="g"
          onChange={(v) => prefs.setMacro('maxFats', v)}
        />
        <RangeSlider
          label="Protein"
          value={prefs.macros.minProtein}
          min={0} max={300} step={5} unit="g" prefix="≥"
          onChange={(v) => prefs.setMacro('minProtein', v)}
        />
        <RangeSlider
          label="Fiber"
          value={prefs.macros.minFiber}
          min={0} max={100} step={1} unit="g" prefix="≥"
          onChange={(v) => prefs.setMacro('minFiber', v)}
        />
      </div>

      <div className="sidebar-section">
        <span className="sidebar-section__label">Dietary Needs</span>
        <RangeSlider
          label="Sodium"
          value={prefs.dietary.maxSodium}
          min={0} max={5000} step={100} unit="mg"
          onChange={(v) => prefs.setDietary('maxSodium', v)}
        />
        <RangeSlider
          label="Sugar"
          value={prefs.dietary.maxSugar}
          min={0} max={200} step={5} unit="g"
          onChange={(v) => prefs.setDietary('maxSugar', v)}
        />
        <div className="checkbox-group checkbox-group--inline">
          {(['isVegetarian', 'isVegan', 'isHalal', 'isKosher'] as const).map((key) => {
            const labels: Record<string, string> = {
              isVegetarian: 'Vegetarian',
              isVegan: 'Vegan',
              isHalal: 'Halal',
              isKosher: 'Kosher',
            };
            return (
              <label key={key} className="checkbox-item">
                <input
                  type="checkbox"
                  checked={prefs.dietary[key] as boolean}
                  onChange={(e) => prefs.setDietary(key, e.target.checked)}
                />
                <span>{labels[key]}</span>
              </label>
            );
          })}
        </div>
        <span className="sidebar-subsection__label">Allergens to avoid</span>
        <CheckboxGroup
          options={ALLERGENS}
          selected={prefs.dietary.allergens}
          onToggle={prefs.toggleAllergen}
        />
      </div>

      <div className="sidebar-section">
        <span className="sidebar-section__label">Time</span>
        <RangeSlider
          label="Prep time"
          value={prefs.maxPrepTime}
          min={0} max={120} step={5} unit=" min"
          onChange={(v) => prefs.set({ maxPrepTime: v })}
        />
        <RangeSlider
          label="Cook time"
          value={prefs.maxCookTime}
          min={0} max={180} step={5} unit=" min"
          onChange={(v) => prefs.set({ maxCookTime: v })}
        />
      </div>

      <div className="sidebar-section">
        <span className="sidebar-section__label">Ingredients to Use Up</span>
        <textarea
          className="sidebar-textarea"
          placeholder="e.g. chicken thighs, half a bag of spinach…"
          value={prefs.leftovers}
          onChange={(e) => prefs.set({ leftovers: e.target.value })}
          rows={3}
        />
      </div>

      <div className="sidebar-section">
        <span className="sidebar-section__label">Other Preferences</span>
        <textarea
          className="sidebar-textarea"
          placeholder="e.g. nothing too spicy, prefer one-pot meals…"
          value={prefs.otherPreferences}
          onChange={(e) => prefs.set({ otherPreferences: e.target.value })}
          rows={3}
        />
      </div>

      <div
        className={`usage-indicator${usage.remaining === 0 ? ' usage-indicator--exhausted' : ''}`}
        title={usage.resetAt ? `Resets in ${timeUntil(usage.resetAt)}` : undefined}
      >
        {usage.remaining} of {usage.limit} generation{usage.limit === 1 ? '' : 's'} left today
      </div>

      <button className="btn-generate" onClick={generate} disabled={isLoading} data-tour="generate-btn">
        {isLoading ? 'Generating…' : 'Generate Meal Plan'}
      </button>
      </div>

      {scrollable && (
        <div className="sidebar__scrollbar-track">
          <div
            className="sidebar__scrollbar-thumb"
            style={{ height: thumbHeight, transform: `translateY(${thumbTop}px)` }}
          />
        </div>
      )}
    </aside>
  );
}
