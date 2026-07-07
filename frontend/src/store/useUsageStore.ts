import { create } from 'zustand';

// Not persisted — always re-derived from the backend, which reads directly
// from the same store the rate limiter itself uses (see /api/meal-plan/usage
// in backend/src/index.ts), so this can never drift out of sync with what
// actually gets enforced.
interface UsageState {
  used: number;
  limit: number;
  remaining: number;
  resetAt: number | null;
  refresh: () => Promise<void>;
}

export const useUsageStore = create<UsageState>((set) => ({
  used: 0,
  limit: 2,
  remaining: 2,
  resetAt: null,

  refresh: async () => {
    try {
      const res = await fetch('/api/meal-plan/usage');
      const json = (await res.json()) as { used: number; limit: number; remaining: number; resetAt: number | null };
      set(json);
    } catch {
      // leave last-known values
    }
  },
}));
