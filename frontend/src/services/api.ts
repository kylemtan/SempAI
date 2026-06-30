import type { MealPlanRequest } from '../store/useMealPlanStore';
import type { MealPlan, Recipe } from '../types/mealPlan';

const BASE = '';

interface SseEvent {
  type: 'progress' | 'done' | 'error';
  message?: string;
  success?: boolean;
  data?: unknown;
  error?: string;
}

async function streamRequest<T>(
  payload: MealPlanRequest,
  onProgress: (msg: string) => void
): Promise<T> {
  const res = await fetch(`${BASE}/api/meal-plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (res.status === 429) {
    const resetHeader = res.headers.get('RateLimit-Reset');
    const resetAt = resetHeader
      ? parseInt(resetHeader) * 1000
      : Date.now() + 24 * 60 * 60 * 1000;
    throw new Error(`RATE_LIMITED:${resetAt}`);
  }

  if (!res.body) throw new Error('No response stream from server');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE messages are delimited by double newlines
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';

    for (const part of parts) {
      const dataLine = part.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue;

      let event: SseEvent;
      try {
        event = JSON.parse(dataLine.slice(6)) as SseEvent;
      } catch {
        continue;
      }

      if (event.type === 'progress' && event.message) {
        onProgress(event.message);
      } else if (event.type === 'done') {
        if (!event.success) throw new Error(event.error ?? 'Generation failed');
        return event.data as T;
      } else if (event.type === 'error') {
        throw new Error(event.error ?? 'Generation failed');
      }
    }
  }

  throw new Error('Stream ended without a result');
}

export async function fetchMealPlan(
  payload: MealPlanRequest,
  onProgress: (msg: string) => void
): Promise<MealPlan> {
  return streamRequest<MealPlan>(payload, onProgress);
}

export interface RegenMeal {
  day: string;
  mealType: string;
  recipe: Recipe;
}

export async function fetchRegenMeals(
  payload: MealPlanRequest,
  onProgress: (msg: string) => void
): Promise<RegenMeal[]> {
  return streamRequest<RegenMeal[]>(payload, onProgress);
}
