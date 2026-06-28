import { Router, Request, Response } from 'express';
import { generateMealPlan, regenerateMeals } from '../services/claudeService.js';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const emit = (payload: Record<string, unknown>) => {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      // client disconnected
    }
  };

  try {
    const handler = req.body.slotsToGenerate ? regenerateMeals : generateMealPlan;
    const data = await handler(req.body, (message) => emit({ type: 'progress', message }));
    emit({ type: 'done', success: true, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected error';
    emit({ type: 'error', success: false, error: message });
  } finally {
    res.end();
  }
});

export default router;
