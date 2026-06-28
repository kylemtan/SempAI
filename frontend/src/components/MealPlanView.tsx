import { useState, useEffect, useRef } from 'react';
import { useMealPlanStore } from '../store/useMealPlanStore';
import DayColumn from './mealplan/DayColumn';
import ShoppingListModal from './ui/ShoppingListModal';
import {
  exportToICS,
  exportSchedulePDF,
  exportShoppingListPDF,
  exportAllRecipesPDF,
  exportFullPlanPDF,
} from '../utils/exportMealPlan';

function formatWeekRange(weekOf: string): string {
  const [y, m, d] = weekOf.split('-').map(Number);
  const start = new Date(y, m - 1, d);
  const end = new Date(y, m - 1, d + 6);
  const startStr = start.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  if (start.getMonth() === end.getMonth()) {
    return `${startStr} – ${end.getDate()}`;
  }
  return `${startStr} – ${end.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`;
}

export default function MealPlanView() {
  const {
    mealPlan, isLoading, progressMessage, error, clearError,
    regenSelection, regenerateSelected, clearRegenSelection,
  } = useMealPlanStore();

  const [messageLog, setMessageLog] = useState<string[]>([]);
  const [showShoppingList, setShowShoppingList] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isLoading) {
      setMessageLog([]);
      return;
    }
    if (progressMessage) {
      setMessageLog((prev) => [...prev.slice(-4), progressMessage]);
    }
  }, [progressMessage, isLoading]);

  useEffect(() => {
    if (!showExportMenu) return;
    function onClickOutside(e: MouseEvent) {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setShowExportMenu(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [showExportMenu]);

  if (isLoading) {
    return (
      <main className="main-panel main-panel--centered">
        <div className="loading-state">
          <div className="loading-spinner" />
          <div className="loading-log">
            {messageLog.length === 0 && (
              <p className="loading-log__msg loading-log__msg--current" key="start">
                Starting…
              </p>
            )}
            {messageLog.map((msg, i) => (
              <p
                key={msg + i}
                className={`loading-log__msg ${i === messageLog.length - 1 ? 'loading-log__msg--current' : 'loading-log__msg--past'}`}
              >
                {msg}
              </p>
            ))}
          </div>
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="main-panel main-panel--centered">
        <div className="error-state">
          <p className="error-state__message">{error}</p>
          <button className="btn-dismiss" onClick={clearError}>Dismiss</button>
        </div>
      </main>
    );
  }

  if (!mealPlan) {
    return (
      <main className="main-panel main-panel--centered">
        <div className="empty-state">
          <span className="empty-state__icon">🍱</span>
          <h2 className="empty-state__title">Your meal plan will appear here</h2>
          <p className="empty-state__body">
            Set your preferences in the sidebar and click <strong>Generate Meal Plan</strong> to create your weekly plan.
          </p>
        </div>
      </main>
    );
  }

  const selectionCount = regenSelection.length;
  const shoppingCount = mealPlan.shoppingList.length;
  const weekLabel = formatWeekRange(mealPlan.weekOf);

  function exportAnd(fn: () => void) {
    fn();
    setShowExportMenu(false);
  }

  return (
    <main className="main-panel">
      <div className="calendar-header">
        <div className="calendar-header__title-group">
          <span className="calendar-header__label">Meal Plan for</span>
          <h2 className="calendar-header__title">{weekLabel}</h2>
        </div>
        <div className="calendar-header__actions">
          <button
            className="calendar-header__shopping-btn"
            onClick={() => setShowShoppingList(true)}
            disabled={shoppingCount === 0}
          >
            Shopping List
            {shoppingCount > 0 && (
              <span className="header-action-btn__badge">{shoppingCount}</span>
            )}
          </button>

          <div className="export-menu-wrapper" ref={exportMenuRef}>
            <button
              className="calendar-header__export-btn"
              onClick={() => setShowExportMenu((v) => !v)}
            >
              Export PDF
              <span className="export-menu-caret">{showExportMenu ? '▴' : '▾'}</span>
            </button>
            {showExportMenu && (
              <div className="export-dropdown">
                <button onClick={() => exportAnd(() => exportSchedulePDF(mealPlan, weekLabel))}>
                  Weekly Schedule
                </button>
                <button onClick={() => exportAnd(() => exportShoppingListPDF(mealPlan, weekLabel))}>
                  Shopping List
                </button>
                <button onClick={() => exportAnd(() => exportAllRecipesPDF(mealPlan, weekLabel))}>
                  All Recipes
                </button>
                <div className="export-dropdown__divider" />
                <button onClick={() => exportAnd(() => exportFullPlanPDF(mealPlan, weekLabel))}>
                  Full Plan
                </button>
              </div>
            )}
          </div>

          <button
            className="calendar-header__export-btn"
            onClick={() => exportToICS(mealPlan)}
          >
            Add to Calendar
          </button>
        </div>
      </div>

      <div className="calendar-wrapper">
        <div className="calendar-grid">
          {mealPlan.mealPlan.map((day) => (
            <DayColumn key={day.day} day={day} />
          ))}
        </div>
      </div>

      {selectionCount > 0 && (
        <div className="regen-bar">
          <span className="regen-bar__label">
            {selectionCount} meal{selectionCount > 1 ? 's' : ''} selected for replacement
          </span>
          <div className="regen-bar__actions">
            <button className="regen-bar__cancel" onClick={clearRegenSelection}>
              Cancel
            </button>
            <button className="regen-bar__confirm" onClick={regenerateSelected}>
              Regenerate
            </button>
          </div>
        </div>
      )}

      {showShoppingList && (
        <ShoppingListModal
          items={mealPlan.shoppingList}
          onClose={() => setShowShoppingList(false)}
        />
      )}
    </main>
  );
}
