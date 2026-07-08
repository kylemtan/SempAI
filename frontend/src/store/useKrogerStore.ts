import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// How many equally-valid candidates (already passed the text-match and
// department-plausibility checks) to price-compare before auto-picking one —
// see MATCH_MODE_POOL_SIZES in ShoppingListModal.tsx.
export type ProductMatchMode = 'accuracy' | 'balanced' | 'price';

// Sort applied to the per-ingredient candidate list in the manual product
// browser (ShoppingListModal.tsx's "editing" phase). Persisted so the user's
// preferred sort carries over between ingredients and future shopping trips.
export type ProductSortKey = 'relevance' | 'kroger' | 'price-asc' | 'price-desc' | 'alpha-asc' | 'alpha-desc';

interface KrogerState {
  isConnected: boolean;
  locationId: string | null;
  locationName: string | null;
  matchMode: ProductMatchMode;
  candidateSort: ProductSortKey;

  initialize: () => Promise<void>;
  disconnect: () => Promise<void>;
  setLocation: (id: string, name: string) => void;
  setMatchMode: (mode: ProductMatchMode) => void;
  setCandidateSort: (sort: ProductSortKey) => void;
}

export const useKrogerStore = create<KrogerState>()(
  persist(
    (set) => ({
      isConnected: false,
      locationId: null,
      locationName: null,
      matchMode: 'balanced',
      candidateSort: 'relevance',

      initialize: async () => {
        try {
          const res = await fetch('/api/kroger/status');
          const json = (await res.json()) as { connected: boolean };
          set({ isConnected: json.connected });
        } catch {
          set({ isConnected: false });
        }
      },

      disconnect: async () => {
        try {
          await fetch('/api/kroger/disconnect', { method: 'POST' });
        } catch {
          // best-effort
        }
        set({ isConnected: false });
      },

      setLocation: (id, name) => set({ locationId: id, locationName: name }),
      setMatchMode: (mode) => set({ matchMode: mode }),
      setCandidateSort: (sort) => set({ candidateSort: sort }),
    }),
    {
      name: 'sempai-kroger',
      partialize: (s) => ({
        locationId: s.locationId,
        locationName: s.locationName,
        matchMode: s.matchMode,
        candidateSort: s.candidateSort,
        // isConnected intentionally not persisted — always derived from backend
      }),
    }
  )
);
