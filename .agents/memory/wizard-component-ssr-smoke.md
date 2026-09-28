---
name: Checking client UI without a browser session
description: The dev app has password login only, so screenshots never reach authenticated pages; what works instead for verifying client components.
---

Rule: do not rely on the screenshot tool for pages behind login (it only ever shows the login form); verify client work with node-side rendering and the Vite dev transform instead.

**Why:** login is password-based with no dev bypass, and the default vitest config only picks up `tests/**/*.test.ts` in node env, so there is no browser-level harness in the repo.

**How to apply:** `renderToStaticMarkup` under a throwaway vitest config (`esbuild.jsx: "automatic"`, `@`/`@shared` aliases, wrap in `QueryClientProvider` + wouter `Router ssrPath`) proves a component renders in every state; Radix dialog portals render empty server-side, so assert on inline markup only. `curl http://127.0.0.1:5000/src/<file>.tsx` returning 200 is a cheap compile check of a page through the running dev server.
