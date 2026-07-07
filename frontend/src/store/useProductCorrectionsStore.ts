import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Remembers manual product picks from the Kroger shopping flow, keyed by a
// normalized ingredient search term, so the next time the same ingredient
// shows up (in a future meal plan, possibly with slightly different wording)
// auto-select can pin the previously-confirmed product instead of re-guessing.
// Deliberately just an ID lookup, not a cached product snapshot — price,
// stock, and availability are always re-checked against the live search
// results, so a remembered pick that's gone (discontinued, different store)
// simply falls back to the normal auto-select logic.
//
// `exclusions` is the negative counterpart: a product explicitly removed for
// a given ingredient (whether it was auto-picked or previously chosen) is
// never auto-picked for that ingredient again, even without a replacement
// having been chosen yet.
interface ProductCorrectionsState {
  corrections: Record<string, string>;
  exclusions: Record<string, string[]>;
  remember: (key: string, productId: string) => void;
  forget: (key: string) => void;
  exclude: (key: string, productId: string) => void;
  clearAll: () => void;
}

export const useProductCorrectionsStore = create<ProductCorrectionsState>()(
  persist(
    (set) => ({
      corrections: {},
      exclusions: {},

      remember: (key, productId) =>
        set((s) => ({ corrections: { ...s.corrections, [key]: productId } })),

      forget: (key) =>
        set((s) => {
          const next = { ...s.corrections };
          delete next[key];
          return { corrections: next };
        }),

      exclude: (key, productId) =>
        set((s) => {
          const existing = s.exclusions[key] ?? [];
          if (existing.includes(productId)) return s;
          return { exclusions: { ...s.exclusions, [key]: [...existing, productId] } };
        }),

      clearAll: () => set({ corrections: {}, exclusions: {} }),
    }),
    { name: 'sempai-product-corrections' }
  )
);
