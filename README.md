# wordstory

A bilingual vocabulary-learning web app. Save the words you don't know, and the app uses Gemini to weave them into short stories, articles, dialogues, letters, or poems you actually want to read. Context-based learning beats rote memorisation.

## Stack
- Single static `index.html` (vanilla HTML/CSS/JS, no framework)
- Two Vercel serverless functions:
  - `api/define.js` — looks up a definition + example for a single word
  - `api/generate.js` — generates a piece in the requested style using your selected words
- Gemini 2.5 Flash via the REST `generateContent` endpoint
- Data is stored in `localStorage` under the `wordstory.*` keys

## Env vars
- `GEMINI_API_KEY` — required, set in Vercel project settings

## Local dev
The app is just an `index.html`; you can open it directly, but the API endpoints need Vercel's runtime. Use `vercel dev` for a local server with the functions wired up.
