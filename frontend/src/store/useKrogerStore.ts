import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface KrogerState {
  isConnected: boolean;
  locationId: string | null;
  locationName: string | null;

  initialize: () => Promise<void>;
  disconnect: () => Promise<void>;
  setLocation: (id: string, name: string) => void;
}

export const useKrogerStore = create<KrogerState>()(
  persist(
    (set) => ({
      isConnected: false,
      locationId: null,
      locationName: null,

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
    }),
    {
      name: 'sempai-kroger',
      partialize: (s) => ({
        locationId: s.locationId,
        locationName: s.locationName,
        // isConnected intentionally not persisted — always derived from backend
      }),
    }
  )
);
