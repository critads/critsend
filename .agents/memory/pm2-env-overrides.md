---
name: PM2 .env overrides vs code defaults
description: Why changing an env-overridable code default (brand-unsub guard, retention, pool sizes…) may do nothing on the Hetzner deployment, and how deploy.sh env probes must be written.
---

**Rule 1 — a code-default change is not a production change.** The PM2 ecosystem config merges the server's `.env` into every process env; any key present there wins over the code default. Production pins several guard values this way (the brand-unsubscribe window/limit the operator sees — 7 days / 2 000 in Sept 2026 — did not match the code defaults at all).
**Why:** after shipping "default 10 → 5 days" the operator would still see 7 days if `.env` pins it; the discrepancy is invisible from the repo.
**How to apply:** whenever a task changes an env-overridable default, ship (a) the default, (b) an explicit note/warning for the `.env` line, and (c) a verification path (the API/UI field that echoes the effective value, or `pm2 jlist` → `pm2_env`).

**Rule 2 — tell operators to SET the new value, never to delete the `.env` line.** `pm2 reload --update-env` merges the new env over the saved dump; a removed key keeps its old value until `pm2 delete` + `pm2 start`. deploy.sh's recreate detector only catches *missing* expected keys, not stale extras.

**Rule 3 — deploy.sh runs under `set -euo pipefail`.** A `$(grep '^KEY=' .env | head -1 | …)` probe exits 1 when the key is absent and aborts the whole deploy before PM2 reload. Always append `|| true` (the pre-existing IMPORT_* probes lack it and only survive because prod `.env` defines those keys). Test new blocks with `bash -euo pipefail -c 'source block.sh'` for absent / equal / different values — a plain-shell simulation hides the abort.
