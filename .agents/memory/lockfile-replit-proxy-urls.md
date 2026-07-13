---
name: Lockfile Replit proxy URLs break external deploys
description: package-lock.json regenerated inside Replit can embed package-firewall.replit.local URLs that make npm ci fail on the Hetzner prod server
---

Rule: after any dependency update inside the Replit workspace, grep `package-lock.json` for `package-firewall.replit.local` and rewrite those `resolved` URLs to `https://registry.npmjs.org/` before the change reaches prod.

**Why:** Replit's npm proxy sometimes writes `http://package-firewall.replit.local/npm/<pkg>/-/<pkg>-<ver>.tgz` into the lockfile. That host only resolves inside Replit. On the self-hosted Hetzner server, `deploy.sh` runs `npm ci`, which first WIPES node_modules and then fails with EAI_AGAIN on those URLs — leaving prod with a half-installed node_modules and crashing processes (2026-07-13 incident: web API served HTML error pages after a pm2 restart on the broken tree).

**How to apply:**
- Fix: `sed -i 's|http://package-firewall.replit.local/npm/|https://registry.npmjs.org/|g' package-lock.json` (integrity hashes stay valid; verify tarball URLs with curl HEAD).
- The user's extra `pm2 restart` after a failed deploy.sh makes it worse — deploy.sh already reloads pm2 only after a successful build; never restart processes on a broken node_modules.
- Recovery on prod: git pull the fixed lockfile, re-run `deploy/deploy.sh` (npm ci rebuilds node_modules cleanly), then check `pm2 status` and drainer restart count.
