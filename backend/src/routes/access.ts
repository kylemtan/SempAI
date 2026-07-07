import { Router, Request, Response } from 'express';

export const TRUSTED_COOKIE = 'sempai_trusted';

export const accessRouter = Router();

// Lets the frontend show a "full access" indicator without ever exposing the
// cookie's contents to client JS (it's httpOnly) — just whether it's valid.
accessRouter.get('/status', (req: Request, res: Response) => {
  res.json({ trusted: !!req.signedCookies?.[TRUSTED_COOKIE] });
});
