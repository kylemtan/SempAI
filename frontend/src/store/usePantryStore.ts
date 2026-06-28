import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { detectCategory, type PantryCategory } from '../data/pantryData';

export interface PantryItem {
  name: string;
  category: PantryCategory;
  addedAt: number;
}

interface PantryState {
  pantry: PantryItem[];
  addToPantry: (items: Array<{ name: string; category?: PantryCategory }>) => void;
  removeFromPantry: (name: string) => void;
  clearPantry: () => void;
}

export const usePantryStore = create<PantryState>()(
  persist(
    (set) => ({
      pantry: [],

      addToPantry: (items) =>
        set((s) => {
          const existing = new Set(s.pantry.map((p) => p.name.toLowerCase().trim()));
          const fresh: PantryItem[] = items
            .filter((i) => i.name.trim() && !existing.has(i.name.toLowerCase().trim()))
            .map((i) => ({
              name: i.name.trim(),
              category: i.category ?? detectCategory(i.name),
              addedAt: Date.now(),
            }));
          return { pantry: [...s.pantry, ...fresh] };
        }),

      removeFromPantry: (name) =>
        set((s) => ({
          pantry: s.pantry.filter(
            (p) => p.name.toLowerCase().trim() !== name.toLowerCase().trim()
          ),
        })),

      clearPantry: () => set({ pantry: [] }),
    }),
    {
      name: 'sempai-pantry',
      merge: (persisted, current) => {
        const p = persisted as Partial<PantryState>;
        const items = (p.pantry ?? []).map((item) => ({
          ...item,
          category: item.category ?? detectCategory(item.name),
        }));
        return { ...current, pantry: items };
      },
    }
  )
);
