---
name: Lockfile Replit proxy URLs break external deploys
description: package-lock.json regenerated inside Replit can embed package-firewall.replit.internal / .local URLs that make npm ci hang or fail on the Hetzner prod server
---

Rule: after any dependency update inside the Replit workspace, grep `package-lock.json` for `package-firewall\.replit\.` (the hostname has been BOTH `.local` and `.internal` — grep the prefix, not one suffix) and rewrite those `resolved` URLs to `https://registry.npmjs.org/` before the change reaches prod. `deploy/deploy.sh` now refuses to run `npm ci` while such URLs are present, so a poisoned lockfile fails the deploy in one second instead of hanging.

**Why:** Replit's npm proxy writes `http://package-firewall.replit.<local|internal>/npm/<pkg>/-/<pkg>-<ver>.tgz` into the lockfile for newly added packages (2026-09: the whole imapflow dependency tree, 23 entries). That host only resolves inside Replit. On the self-hosted Hetzner server `npm ci` first WIPES node_modules and then either fails with EAI_AGAIN (2026-07-13 incident: web API served HTML error pages after a pm2 restart on the broken tree) or, when the name resolves nowhere, sits on connection retries and looks "stuck" right after the npm deprecation warnings (2026-09-29).

**How to apply:**
- Fix: `sed -i 's#"resolved": "http://package-firewall.replit.internal/npm/#"resolved": "https://registry.npmjs.org/#' package-lock.json` (same for `.local`); integrity hashes stay valid — verify by fetching each rewritten tarball and comparing sha512 with the lock's `integrity`.
- The user's extra `pm2 restart` after a failed deploy.sh makes it worse — deploy.sh already reloads pm2 only after a successful build; never restart processes on a broken node_modules.
- Recovery on prod: Ctrl-C the hung `npm ci`, `git pull` the fixed lockfile, re-run `deploy/deploy.sh` (npm ci rebuilds node_modules cleanly), then check `pm2 status` and restart counts.
