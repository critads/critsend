---
name: node-postgres sslmode overrides ssl object
description: Why a self-signed Postgres server cert throws "self-signed certificate" even when code sets ssl.rejectUnauthorized=false
---

# node-postgres: connection-string `sslmode` overrides the explicit `ssl` config object

When a Postgres connection is configured with BOTH a `connectionString` (containing
`?sslmode=...`) AND an explicit `ssl: { rejectUnauthorized: false }` object, the
connection string WINS. node-postgres' `ConnectionParameters` builds config as
`Object.assign({}, config, parse(connectionString))` — the parsed connection string
is the last argument, so its `ssl` settings overwrite the explicit object.

Combined with the pg ≥ 8.11 change where `sslmode=require` now **verifies** the cert
(older versions silently skipped verification), pointing the app at a server with a
**self-signed** cert throws `Error: self-signed certificate` at every query — even
though the code "set" `rejectUnauthorized: false`. The setting is discarded.

**Fix:** put the intent in the connection string itself — use `sslmode=no-verify`
(encrypts but does not verify the signer). Then the parsed string and the code agree.
`sslmode` values: `disable | require | no-verify | verify-ca | verify-full`; only
`no-verify` maps to `rejectUnauthorized: false`.

**Why:** self-hosted Critsend DB (Hetzner, 157.180.98.150) uses a self-signed server
cert. The Neon→Hetzner cutover failed with `self-signed certificate` until the app's
`DATABASE_URL` / `NEON_DATABASE_URL` were changed from `sslmode=require` to
`sslmode=no-verify`. Same change also unblocks `drizzle-kit push` in deploy.sh, which
reads the same URL.

**How to apply:** any time the app talks TLS to a Postgres server whose cert is not
signed by a trusted CA, use `sslmode=no-verify` in the URL — do NOT rely on a code-side
`ssl: { rejectUnauthorized: false }`, it is silently overridden by the URL's sslmode.
Hardening alternative: install the server cert as a CA on the app box and use
`sslmode=verify-full` (the cert's SAN includes `IP:157.180.98.150`).
