---
name: DB target & script exit in this repl
description: Which DB each tool hits (PROD vs DEV) and why standalone scripts importing server/db hang on exit.
---

# DB target & standalone script exit

## Two databases, two tools
- **`npx tsx scripts/*.ts` (importing `../server/db`) connects to PRODUCTION** (this repl's `NEON_DATABASE_URL`/`DATABASE_URL` point at prod Neon). Confirmed by a 284 GB `tracking_tokens`.
- **The `executeSql` code-execution sandbox connects to the DEV database** (a clean/separate Neon DB).
- **How to apply:** rehearse destructive logic on DEV with `executeSql`; treat any `tsx` script run as touching prod. Never run a destructive migration step via `tsx` without explicit user sign-off.

## Standalone scripts must force-exit
- `server/db.ts` arms **non-unref'd** timers (a 30s pool-stats `setInterval` + a keepalive on external DBs). A script that finishes its work and calls `pool.end()` still **hangs** because those timers keep the event loop alive → the run only ends on timeout (RC 124).
- **How to apply:** end migration/diagnostic scripts with `process.exit(process.exitCode ?? 0)` in the `.finally` after `pool.end()` (matches `scripts/reclaim-tracking-tokens.ts`).
