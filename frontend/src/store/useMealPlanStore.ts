import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { DayPlan, MealPlan, Recipe, ShoppingItem } from '../types/mealPlan';
import { fetchMealPlan, fetchRegenMeals } from '../services/api';
import { usePreferencesStore, todayISO } from './usePreferencesStore';
import { useUsageStore } from './useUsageStore';

function normalizeIngredientName(name: string): string {
  let n = name.trim();
  n = n.replace(/\s*\([^)]*\)/g, '');
  n = n.replace(/,.*$/, '');
  n = n.replace(
    /\s+(for\s+(garnish|serving|topping)|to\s+(garnish|taste|serve|finish)|optional|as\s+needed|to\s+finish)\s*$/i,
    ''
  );
  n = n.replace(
    /^(freshly\s+|roughly\s+|finely\s+|thinly\s+|coarsely\s+|lightly\s+)?(fresh\s+)?(chopped|minced|diced|sliced|grated|shredded|peeled|cubed|torn|crumbled|crushed|trimmed|halved|quartered)\s+/i,
    ''
  );
  return n.trim().toLowerCase();
}

function toTitleCase(str: string): string {
  return str.replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildShoppingList(days: DayPlan[]): ShoppingItem[] {
  const map = new Map<string, { krogerSearchTerm: string; displayName: string; byUnit: Map<string, number>; usedIn: Set<string> }>();
  for (const day of days) {
    for (const meal of day.meals) {
      const recipeName = meal.recipe.name;
      for (const ing of meal.recipe.ingredients) {
        const key = normalizeIngredientName(ing.name);
        if (!map.has(key)) {
          map.set(key, { krogerSearchTerm: ing.krogerSearchTerm, displayName: toTitleCase(key), byUnit: new Map(), usedIn: new Set() });
        }
        const entry = map.get(key)!;
        const unit = (ing.unit ?? '').toLowerCase().trim();
        entry.byUnit.set(unit, (entry.byUnit.get(unit) ?? 0) + (ing.quantity ?? 0));
        entry.usedIn.add(recipeName);
      }
    }
  }
  return Array.from(map.values()).map((entry) => {
    const estimatedQuantity = Array.from(entry.byUnit.entries())
      .map(([unit, amount]) => {
        const rounded = Math.round(amount * 100) / 100;
        const num = rounded % 1 === 0 ? String(rounded) : String(rounded);
        return unit ? `${num} ${unit}` : num;
      })
      .join(' + ');
    return { krogerSearchTerm: entry.krogerSearchTerm, displayName: entry.displayName, estimatedQuantity, usedIn: Array.from(entry.usedIn) };
  });
}

export interface MealPlanRequest {
  cuisines: string[];
  equipment: string[];
  macros: { maxCalories: number; maxCarbs: number; maxFats: number; minFiber: number; minProtein: number };
  dietary: {
    maxSodium: number;
    allergens: string[];
    isVegetarian: boolean;
    isVegan: boolean;
    isHalal: boolean;
    isKosher: boolean;
    maxSugar: number;
  };
  maxPrepTime: number;
  maxCookTime: number;
  mealsPerDay: number;
  startDate?: string;
  numDays?: number;
  leftovers: string;
  otherPreferences: string;
  searchMode?: 'web' | 'training';
  blacklist: string[];
  pinnedRecipes?: { name: string; cuisineHint: string; mealType: string }[];
  slotsToGenerate?: { day: string; date: string; mealType: string }[];
  existingDayMeals?: {
    day: string;
    meals: {
      mealType: string;
      name: string;
      macros: { calories: number; carbohydrates: number; protein: number; fats: number; sugar: number };
    }[];
  }[];
}

export interface BlacklistEntry {
  id: string;
  name: string;
  addedAt: number;
}

export interface FavoriteEntry {
  recipe: Recipe;
  mealType: string;
  savedAt: number;
}

export const BLACKLIST_TTL_MS = 28 * 24 * 60 * 60 * 1000;

export function regenKey(day: string, mealType: string): string {
  return `${day}|||${mealType}`;
}

interface MealPlanState {
  mealPlan: MealPlan | null;
  isLoading: boolean;
  progressMessage: string;
  error: string | null;
  blacklist: BlacklistEntry[];
  favorites: FavoriteEntry[];
  pinnedFavoriteIds: string[];
  regenSelection: string[];
  shoppingListStale: boolean;
  cartedTerms: string[];

  generate: () => Promise<void>;
  regenerateSelected: () => Promise<void>;
  addToBlacklist: (entries: { id: string; name: string }[]) => void;
  removeFromBlacklist: (id: string) => void;
  clearBlacklist: () => void;
  clearError: () => void;
  toggleFavorite: (recipe: Recipe, mealType: string) => void;
  removeFavorite: (id: string) => void;
  togglePinFavorite: (id: string) => void;
  toggleRegenSelection: (day: string, mealType: string) => void;
  clearRegenSelection: () => void;
  addToCarted: (terms: string[]) => void;
  removeFromCarted: (term: string) => void;
  clearCarted: () => void;
}

function buildPrefsPayload(
  prefs: ReturnType<typeof usePreferencesStore.getState>,
  activeBlacklist: string[],
  extra?: Partial<MealPlanRequest>
): MealPlanRequest {
  return {
    cuisines: prefs.cuisines,
    equipment: prefs.equipment,
    macros: prefs.macros,
    dietary: prefs.dietary,
    maxPrepTime: prefs.maxPrepTime,
    maxCookTime: prefs.maxCookTime,
    mealsPerDay: prefs.mealsPerDay,
    startDate: prefs.startDate || todayISO(),
    numDays: prefs.numDays,
    leftovers: prefs.leftovers,
    otherPreferences: prefs.otherPreferences,
    searchMode: prefs.searchMode,
    blacklist: activeBlacklist,
    ...extra,
  };
}

export const useMealPlanStore = create<MealPlanState>()(
  persist(
    (set, get) => ({
      mealPlan: null,
      isLoading: false,
      progressMessage: '',
      error: null,
      blacklist: [],
      favorites: [],
      pinnedFavoriteIds: [],
      regenSelection: [],
      shoppingListStale: false,
      cartedTerms: [],

      generate: async () => {
        set({ isLoading: true, progressMessage: '', error: null });
        try {
          const prefs = usePreferencesStore.getState();
          const now = Date.now();
          const { blacklist, pinnedFavoriteIds, favorites } = get();

          const activeBlacklist = blacklist
            .filter((e) => now - e.addedAt < BLACKLIST_TTL_MS)
            .map((e) => e.name);

          const pinnedRecipes = favorites
            .filter((f) => pinnedFavoriteIds.includes(f.recipe.id))
            .map((f) => ({ name: f.recipe.name, cuisineHint: f.recipe.cuisine, mealType: f.mealType }));

          const payload = buildPrefsPayload(prefs, activeBlacklist, {
            pinnedRecipes: pinnedRecipes.length > 0 ? pinnedRecipes : undefined,
          });

          const mealPlan = await fetchMealPlan(payload, (msg) => set({ progressMessage: msg }));

          const newEntries = mealPlan.mealPlan.flatMap((day) =>
            day.meals.map((meal) => ({ id: meal.recipe.id, name: meal.recipe.name, addedAt: now }))
          );
          get().addToBlacklist(newEntries);

          set({ mealPlan, isLoading: false, progressMessage: '', pinnedFavoriteIds: [], shoppingListStale: false, cartedTerms: [] });
        } catch (err) {
          set({
            error: err instanceof Error ? err.message : 'Something went wrong',
            isLoading: false,
            progressMessage: '',
          });
        } finally {
          useUsageStore.getState().refresh();
        }
      },

      regenerateSelected: async () => {
        const { mealPlan, regenSelection } = get();
        if (!mealPlan || regenSelection.length === 0) return;

        set({ isLoading: true, progressMessage: '', error: null });
        try {
          const prefs = usePreferencesStore.getState();
          const now = Date.now();

          const toReplace = regenSelection
            .map((key) => {
              const [day, mealType] = key.split('|||');
              const dayPlan = mealPlan.mealPlan.find((d) => d.day === day);
              const meal = dayPlan?.meals.find((m) => m.mealType === mealType);
              return { day, date: dayPlan?.date ?? '', mealType, recipe: meal?.recipe };
            })
            .filter((r) => r.date);

          // Blacklist the recipes being swapped out
          get().addToBlacklist(
            toReplace
              .filter((r) => r.recipe)
              .map((r) => ({ id: r.recipe!.id, name: r.recipe!.name }))
          );

          const activeBlacklist = get().blacklist
            .filter((e) => now - e.addedAt < BLACKLIST_TTL_MS)
            .map((e) => e.name);

          const slotsToGenerate = toReplace.map(({ day, date, mealType }) => ({ day, date, mealType }));

          // For each day that has slots being regenerated, collect the OTHER meals
          // so the backend can compute the remaining macro budget.
          const daysSeen = new Set<string>();
          const existingDayMeals = toReplace
            .filter(({ day }) => {
              if (daysSeen.has(day)) return false;
              daysSeen.add(day);
              return true;
            })
            .map(({ day }) => {
              const replacingTypes = new Set(
                toReplace.filter((r) => r.day === day).map((r) => r.mealType)
              );
              const dayPlan = mealPlan.mealPlan.find((d) => d.day === day);
              const otherMeals = (dayPlan?.meals ?? [])
                .filter((m) => !replacingTypes.has(m.mealType))
                .map((m) => ({
                  mealType: m.mealType,
                  name: m.recipe.name,
                  macros: {
                    calories: m.recipe.macros.calories,
                    carbohydrates: m.recipe.macros.carbohydrates,
                    protein: m.recipe.macros.protein,
                    fats: m.recipe.macros.fats,
                    sugar: m.recipe.macros.sugar,
                  },
                }));
              return { day, meals: otherMeals };
            })
            .filter(({ meals }) => meals.length > 0);

          const payload = buildPrefsPayload(prefs, activeBlacklist, {
            slotsToGenerate,
            existingDayMeals: existingDayMeals.length > 0 ? existingDayMeals : undefined,
          });

          const regenerated = await fetchRegenMeals(payload, (msg) => set({ progressMessage: msg }));

          const updatedDays = mealPlan.mealPlan.map((dayPlan) => ({
            ...dayPlan,
            meals: dayPlan.meals.map((meal) => {
              const replacement = regenerated.find(
                (r) => r.day === dayPlan.day && r.mealType === meal.mealType
              );
              return replacement ? { mealType: meal.mealType, recipe: replacement.recipe } : meal;
            }),
          }));

          const updatedPlan: MealPlan = {
            ...mealPlan,
            mealPlan: updatedDays,
            shoppingList: buildShoppingList(updatedDays),
          };

          // Blacklist the newly generated recipes
          get().addToBlacklist(
            regenerated.map((r) => ({ id: r.recipe.id, name: r.recipe.name }))
          );

          set({ mealPlan: updatedPlan, isLoading: false, progressMessage: '', regenSelection: [], shoppingListStale: false });
        } catch (err) {
          set({
            error: err instanceof Error ? err.message : 'Something went wrong',
            isLoading: false,
            progressMessage: '',
          });
        } finally {
          useUsageStore.getState().refresh();
        }
      },

      addToBlacklist: (entries) =>
        set((s) => {
          const existing = new Set(s.blacklist.map((e) => e.id));
          const fresh = entries
            .filter((e) => !existing.has(e.id))
            .map((e) => ({ ...e, addedAt: Date.now() }));
          return { blacklist: [...s.blacklist, ...fresh] };
        }),

      removeFromBlacklist: (id) =>
        set((s) => ({ blacklist: s.blacklist.filter((e) => e.id !== id) })),

      clearBlacklist: () => set({ blacklist: [] }),
      clearError: () => set({ error: null }),

      toggleFavorite: (recipe, mealType) =>
        set((s) => {
          const exists = s.favorites.some((f) => f.recipe.id === recipe.id);
          if (exists) {
            return {
              favorites: s.favorites.filter((f) => f.recipe.id !== recipe.id),
              pinnedFavoriteIds: s.pinnedFavoriteIds.filter((id) => id !== recipe.id),
            };
          }
          return { favorites: [...s.favorites, { recipe, mealType, savedAt: Date.now() }] };
        }),

      removeFavorite: (id) =>
        set((s) => ({
          favorites: s.favorites.filter((f) => f.recipe.id !== id),
          pinnedFavoriteIds: s.pinnedFavoriteIds.filter((pid) => pid !== id),
        })),

      togglePinFavorite: (id) =>
        set((s) => ({
          pinnedFavoriteIds: s.pinnedFavoriteIds.includes(id)
            ? s.pinnedFavoriteIds.filter((i) => i !== id)
            : [...s.pinnedFavoriteIds, id],
        })),

      toggleRegenSelection: (day, mealType) => {
        const key = regenKey(day, mealType);
        set((s) => ({
          regenSelection: s.regenSelection.includes(key)
            ? s.regenSelection.filter((k) => k !== key)
            : [...s.regenSelection, key],
        }));
      },

      clearRegenSelection: () => set({ regenSelection: [] }),

      addToCarted: (terms) =>
        set((s) => ({ cartedTerms: [...new Set([...s.cartedTerms, ...terms])] })),

      removeFromCarted: (term) =>
        set((s) => ({ cartedTerms: s.cartedTerms.filter((t) => t !== term) })),

      clearCarted: () => set({ cartedTerms: [] }),
    }),
    {
      name: 'sempai-meal-plan',
      partialize: (s) => ({
        mealPlan: s.mealPlan,
        blacklist: s.blacklist,
        favorites: s.favorites,
        pinnedFavoriteIds: s.pinnedFavoriteIds,
        cartedTerms: s.cartedTerms,
        // regenSelection intentionally not persisted
      }),
    }
  )
);
