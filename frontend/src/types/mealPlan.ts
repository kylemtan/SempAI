export interface Macros {
  calories: number;
  carbohydrates: number;
  protein: number;
  fats: number;
  fiber: number;
  sodium: number;
  sugar: number;
}

export interface Ingredient {
  name: string;
  quantity: number;
  unit: string;
  krogerSearchTerm: string;
}

export interface Recipe {
  id: string;
  name: string;
  cuisine: string;
  prepTime: number;
  cookTime: number;
  servings: number;
  macros: Macros;
  dietaryTags: string[];
  equipment: string[];
  ingredients: Ingredient[];
  steps: string[];
  notes: string;
  sourceSite: string;
  sourceUrl: string | null;
  imageUrl: string | null;
  aiGenerated?: boolean;
}

export interface Meal {
  mealType: string;
  recipe: Recipe;
}

export interface DayPlan {
  day: string;
  date: string;
  meals: Meal[];
}

export interface ShoppingItem {
  krogerSearchTerm: string;
  displayName: string;
  estimatedQuantity: string;
  usedIn: string[];
}

export interface MealPlan {
  weekOf: string;
  mealPlan: DayPlan[];
  shoppingList: ShoppingItem[];
}
