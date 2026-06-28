# SempAI

AI-powered meal planning web app. Generate a personalised weekly meal plan, browse full recipes sourced from real cooking sites, manage your shopping list, and add items directly to your Kroger cart.

## Features

- **AI meal planning** — generate 1–7 days of meals starting on any date, with full recipe details (ingredients, steps, macros, source links)
- **Customisable preferences** — cuisine, dietary lifestyle (vegan, halal, kosher…), allergens, macro targets, prep/cook time limits, and meals per day (1–6)
- **Ingredient use-up** — tell SempAI what's in your fridge and it'll work those ingredients into 1–2 recipes
- **Selective regeneration** — swap out individual meals without regenerating the whole plan
- **Favorites & pinning** — star recipes to save them; pin favorites so they appear in your next generated plan
- **Recent recipes** — automatically avoids repeating recipes for 4 weeks
- **Shopping list** — combined, deduplicated ingredient list with quantity estimates
- **Kroger integration** — connect your Kroger account to browse products and add items to your cart directly
- **Pantry** — log what you already have; pantry items are separated in the shopping list and auto-added when you cart items
- **Export** — save your plan as a PDF (schedule, shopping list, all recipes, or everything) or add meals to any calendar app via `.ics`
- **Dark mode**

## Tech stack

| Layer | Tech |
|---|---|
| Frontend | React 19, TypeScript, Vite, Zustand |
| Backend | Node.js, Express, TypeScript (ESM) |
| AI | Claude Haiku 4.5 (Anthropic) |
| Recipe search | Tavily |
| Grocery | Kroger API |

## Local development

### Prerequisites

- Node.js 20+
- API keys for [Anthropic](https://console.anthropic.com), [Tavily](https://tavily.com), and optionally [Kroger](https://developer.kroger.com)

### Setup

```bash
git clone https://github.com/kylemtan/SempAI.git
cd SempAI
npm install
```

Copy the environment file and fill in your keys:

```bash
cp backend/.env.example backend/.env
```

```env
ANTHROPIC_API_KEY=...
TAVILY_API_KEY=...
KROGER_CLIENT_ID=...       # optional
KROGER_CLIENT_SECRET=...   # optional
PORT=3001
```

Start both servers:

```bash
npm run dev
```

The app runs at `http://localhost:5173`. The Vite dev server proxies `/api` and `/auth` to the Express backend on port 3001.

## Deployment (Render)

The repo includes a `render.yaml` that configures everything automatically.

1. Push to GitHub
2. Go to [render.com](https://render.com) → **New → Blueprint** and connect this repo — Render will pick up `render.yaml`
3. Set the following environment variables in the Render dashboard:

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `TAVILY_API_KEY` | Tavily API key |
| `KROGER_CLIENT_ID` | Kroger app client ID |
| `KROGER_CLIENT_SECRET` | Kroger app client secret |
| `APP_URL` | Your Render public URL, e.g. `https://sempai.onrender.com` |

4. In the [Kroger Developer Portal](https://developer.kroger.com), add `https://your-app.onrender.com/auth/kroger/callback` as an allowed redirect URI.

In production, Express serves the built frontend as static files — no separate static site needed.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | — | Claude API key |
| `TAVILY_API_KEY` | Yes | — | Tavily search/extract API key |
| `KROGER_CLIENT_ID` | No | — | Enables Kroger cart integration |
| `KROGER_CLIENT_SECRET` | No | — | Enables Kroger cart integration |
| `APP_URL` | Production | — | Public URL used for Kroger OAuth redirect |
| `PORT` | No | `3001` | Backend port |
| `CORS_ORIGIN` | No | `http://localhost:5173` | Allowed CORS origin in development |
