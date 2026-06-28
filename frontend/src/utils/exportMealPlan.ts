import type { MealPlan, DayPlan, Meal, Recipe, ShoppingItem } from '../types/mealPlan';

// ── Shared helpers ─────────────────────────────────────────────────────────────

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function openPrintWindow(title: string, bodyHtml: string, extraCss = '') {
  const win = window.open('', '_blank');
  if (!win) return;
  win.document.write(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 11px; color: #111; background: #fff; padding: 32px; }
  h1 { font-size: 22px; font-weight: 700; margin-bottom: 4px; }
  h2.section-title { font-size: 16px; font-weight: 700; margin-bottom: 12px; padding-bottom: 6px; border-bottom: 2px solid #111; }
  .subtitle { color: #666; font-size: 12px; margin-bottom: 28px; }
  .section { margin-bottom: 32px; }
  ${extraCss}
  @media print { body { padding: 20px; } @page { margin: 1cm; } }
</style>
</head>
<body>
${bodyHtml}
<script>window.onload = () => { window.print(); }<\/script>
</body>
</html>`);
  win.document.close();
}

// ── Section builders ───────────────────────────────────────────────────────────

const SCHEDULE_CSS = `
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
  .day { border: 1px solid #e0e0e0; border-radius: 8px; padding: 12px; break-inside: avoid; }
  .day__title { font-size: 13px; font-weight: 700; margin-bottom: 8px; padding-bottom: 5px; border-bottom: 1px solid #eee; }
  .day__date { font-weight: 400; color: #888; font-size: 11px; }
  .meal { margin-bottom: 9px; }
  .meal:last-child { margin-bottom: 0; }
  .meal__type { font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; color: #c0392b; font-weight: 700; margin-bottom: 1px; }
  .meal__name { font-size: 12px; font-weight: 600; margin-bottom: 2px; }
  .meal__meta { font-size: 10px; color: #555; margin-bottom: 1px; }
  .meal__macros { font-size: 10px; color: #999; }
  @media print { @page { size: A4 landscape; } }
`;

function mealHtml(m: Meal): string {
  const { recipe } = m;
  const time = recipe.prepTime + recipe.cookTime;
  return `<div class="meal">
    <div class="meal__type">${capitalize(m.mealType)}</div>
    <div class="meal__name">${recipe.name}</div>
    <div class="meal__meta">${recipe.cuisine} · ${time}min · ${recipe.macros.calories} kcal</div>
    <div class="meal__macros">Protein ${recipe.macros.protein}g · Carbs ${recipe.macros.carbohydrates}g · Fat ${recipe.macros.fats}g</div>
  </div>`;
}

function dayHtml(d: DayPlan): string {
  const dateLabel = new Date(d.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `<div class="day">
    <div class="day__title">${d.day} <span class="day__date">${dateLabel}</span></div>
    ${d.meals.map(mealHtml).join('')}
  </div>`;
}

function scheduleSectionHtml(days: DayPlan[]): string {
  return `<div class="section">
    <h2 class="section-title">Weekly Schedule</h2>
    <div class="grid">${days.map(dayHtml).join('')}</div>
  </div>`;
}

const SHOPPING_CSS = `
  .shop-list { list-style: none; display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px 16px; }
  .shop-list li { font-size: 11px; padding: 4px 0; border-bottom: 1px solid #f0f0f0; display: flex; justify-content: space-between; }
  .shop-qty { color: #888; }
`;

function shoppingSectionHtml(items: ShoppingItem[]): string {
  if (!items.length) return '';
  const rows = items.map((i) =>
    `<li><span>${i.displayName}</span><span class="shop-qty">${i.estimatedQuantity}</span></li>`
  ).join('');
  return `<div class="section">
    <h2 class="section-title">Shopping List</h2>
    <ul class="shop-list">${rows}</ul>
  </div>`;
}

const RECIPE_CSS = `
  .recipe { border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px; margin-bottom: 20px; break-inside: avoid; }
  .recipe__name { font-size: 16px; font-weight: 700; margin-bottom: 3px; }
  .recipe__meta { font-size: 11px; color: #666; margin-bottom: 10px; }
  .recipe__macros { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; padding: 8px 0; border-top: 1px solid #eee; border-bottom: 1px solid #eee; }
  .macro { display: flex; flex-direction: column; align-items: center; }
  .macro__label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: #999; }
  .macro__value { font-size: 12px; font-weight: 600; }
  .recipe__columns { display: grid; grid-template-columns: 1fr 2fr; gap: 16px; margin-top: 10px; }
  .recipe__col-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #c0392b; margin-bottom: 6px; }
  .recipe__ings { list-style: none; }
  .recipe__ings li { font-size: 11px; padding: 2px 0; border-bottom: 1px solid #f5f5f5; }
  .recipe__ing-qty { color: #888; margin-right: 4px; }
  .recipe__steps { padding-left: 16px; }
  .recipe__steps li { font-size: 11px; margin-bottom: 5px; line-height: 1.5; }
  .recipe__notes { font-size: 11px; color: #777; margin-top: 10px; font-style: italic; padding-top: 8px; border-top: 1px solid #eee; }
  .recipe__type-badge { font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em; color: #c0392b; font-weight: 700; margin-bottom: 4px; }
`;

export function recipeCardHtml(recipe: Recipe, mealType?: string): string {
  const totalTime = recipe.prepTime + recipe.cookTime;
  const macros = [
    { label: 'Calories', value: `${recipe.macros.calories} kcal` },
    { label: 'Protein', value: `${recipe.macros.protein}g` },
    { label: 'Carbs', value: `${recipe.macros.carbohydrates}g` },
    { label: 'Fat', value: `${recipe.macros.fats}g` },
    { label: 'Fiber', value: `${recipe.macros.fiber}g` },
    { label: 'Sugar', value: `${recipe.macros.sugar}g` },
    { label: 'Sodium', value: `${recipe.macros.sodium}mg` },
  ];

  return `<div class="recipe">
    ${mealType ? `<div class="recipe__type-badge">${capitalize(mealType)}</div>` : ''}
    <div class="recipe__name">${recipe.name}</div>
    <div class="recipe__meta">${recipe.cuisine} · Prep ${recipe.prepTime}min · Cook ${recipe.cookTime}min · ${totalTime}min total · Serves ${recipe.servings}</div>
    <div class="recipe__macros">
      ${macros.map((m) => `<div class="macro"><span class="macro__label">${m.label}</span><span class="macro__value">${m.value}</span></div>`).join('')}
    </div>
    <div class="recipe__columns">
      <div>
        <div class="recipe__col-title">Ingredients</div>
        <ul class="recipe__ings">
          ${recipe.ingredients.map((ing) => `<li><span class="recipe__ing-qty">${ing.quantity} ${ing.unit}</span>${ing.name}</li>`).join('')}
        </ul>
      </div>
      <div>
        <div class="recipe__col-title">Instructions</div>
        <ol class="recipe__steps">
          ${recipe.steps.map((s) => `<li>${s}</li>`).join('')}
        </ol>
      </div>
    </div>
    ${recipe.notes ? `<div class="recipe__notes">${recipe.notes}</div>` : ''}
  </div>`;
}

function allRecipesSectionHtml(days: DayPlan[]): string {
  const cards = days.flatMap((d) =>
    d.meals.map((m) => recipeCardHtml(m.recipe, m.mealType))
  ).join('');
  return `<div class="section">
    <h2 class="section-title">Recipes</h2>
    ${cards}
  </div>`;
}

// ── PDF exports ────────────────────────────────────────────────────────────────

export function exportSchedulePDF(mealPlan: MealPlan, weekLabel: string): void {
  openPrintWindow(
    `Meal Plan — ${weekLabel}`,
    `<h1>Meal Plan</h1><p class="subtitle">${weekLabel} · Generated by SempAI</p>
     ${scheduleSectionHtml(mealPlan.mealPlan)}`,
    SCHEDULE_CSS,
  );
}

export function exportShoppingListPDF(mealPlan: MealPlan, weekLabel: string): void {
  openPrintWindow(
    `Shopping List — ${weekLabel}`,
    `<h1>Shopping List</h1><p class="subtitle">${weekLabel} · Generated by SempAI</p>
     ${shoppingSectionHtml(mealPlan.shoppingList)}`,
    SHOPPING_CSS,
  );
}

export function exportAllRecipesPDF(mealPlan: MealPlan, weekLabel: string): void {
  openPrintWindow(
    `Recipes — ${weekLabel}`,
    `<h1>Recipes</h1><p class="subtitle">${weekLabel} · Generated by SempAI</p>
     ${allRecipesSectionHtml(mealPlan.mealPlan)}`,
    RECIPE_CSS,
  );
}

export function exportFullPlanPDF(mealPlan: MealPlan, weekLabel: string): void {
  openPrintWindow(
    `Full Meal Plan — ${weekLabel}`,
    `<h1>Meal Plan</h1><p class="subtitle">${weekLabel} · Generated by SempAI</p>
     ${scheduleSectionHtml(mealPlan.mealPlan)}
     ${shoppingSectionHtml(mealPlan.shoppingList)}
     ${allRecipesSectionHtml(mealPlan.mealPlan)}`,
    SCHEDULE_CSS + SHOPPING_CSS + RECIPE_CSS,
  );
}

export function exportSingleRecipePDF(recipe: Recipe, mealType: string): void {
  openPrintWindow(
    recipe.name,
    recipeCardHtml(recipe, mealType),
    RECIPE_CSS,
  );
}

// ── ICS export ─────────────────────────────────────────────────────────────────

const MEAL_TIMES: Record<string, [number, number]> = {
  'breakfast':       [8,  0],
  'morning snack':   [10, 30],
  'lunch':           [12, 0],
  'afternoon snack': [15, 0],
  'snack':           [15, 0],
  'dinner':          [18, 30],
  'evening snack':   [20, 30],
};

function icsDate(dateStr: string, hour: number, minute: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${y}${pad(m)}${pad(d)}T${pad(hour)}${pad(minute)}00`;
}

function addMinutes(dateStr: string, hour: number, minute: number, mins: number): string {
  const total = hour * 60 + minute + mins;
  return icsDate(dateStr, Math.floor(total / 60) % 24, total % 60);
}

function escapeICS(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

export function exportToICS(mealPlan: MealPlan): void {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SempAI//Meal Plan//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];

  for (const day of mealPlan.mealPlan) {
    for (const meal of day.meals) {
      const [hour, minute] = MEAL_TIMES[meal.mealType.toLowerCase()] ?? [12, 0];
      const duration = Math.max((meal.recipe.prepTime ?? 0) + (meal.recipe.cookTime ?? 0), 30);
      const dtStart = icsDate(day.date, hour, minute);
      const dtEnd = addMinutes(day.date, hour, minute, duration);
      const { macros } = meal.recipe;

      const descParts = [
        `${macros.calories} kcal · Protein: ${macros.protein}g · Carbs: ${macros.carbohydrates}g · Fat: ${macros.fats}g`,
        meal.recipe.cuisine ? `Cuisine: ${meal.recipe.cuisine}` : '',
        meal.recipe.sourceUrl ? `Recipe: ${meal.recipe.sourceUrl}` : '',
      ].filter(Boolean);

      lines.push(
        'BEGIN:VEVENT',
        `DTSTART:${dtStart}`,
        `DTEND:${dtEnd}`,
        `SUMMARY:${escapeICS(`${capitalize(meal.mealType)}: ${meal.recipe.name}`)}`,
        `DESCRIPTION:${escapeICS(descParts.join('\\n'))}`,
        `UID:${meal.recipe.id}-${day.date}@sempai`,
        'END:VEVENT',
      );
    }
  }

  lines.push('END:VCALENDAR');

  const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
  downloadBlob(blob, `meal-plan-${mealPlan.weekOf}.ics`);
}
