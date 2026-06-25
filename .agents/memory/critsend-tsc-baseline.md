---
name: Critsend tsc baseline & nodemailer createTransport overload
description: This repo has no clean tsc baseline (builds via esbuild); how to tell new errors from pre-existing noise, and the nodemailer overload quirk.
---

# Critsend tsc is a lint aid, NOT a gate

`npx tsc --noEmit` on this repo reports MANY pre-existing errors (segments.ts,
automation-engine.ts, workers.ts, mtas.ts, ...). The app builds/runs via esbuild
(tsx / vite), which strips types and does not typecheck, so a non-empty tsc output
is normal and is not a regression by itself.

**How to apply:** after editing, run tsc filtered to the files you touched and compare
against the known pre-existing set. Only fix NEW error *classes* you introduced; do
not try to zero out the whole baseline (out of scope and risky).

## nodemailer.createTransport TS2769 overload (cosmetic, tolerated)

A one-off non-pooled transport — `nodemailer.createTransport({ host, port, secure,
ignoreTLS, auth, pool: false, ...timeouts, tls })` — trips:
`TS2769 No overload matches... 'host' does not exist in type 'TransportOptions |
Transport<...>'`. The POOLED `createTransporter` in `server/email-service.ts`
(`pool: true`) does NOT trip it. The pre-existing instance lives in
`testSmtpConnection` (server/routes/mtas.ts); the Plain Test helper mirrors it.

**Why:** the object is valid runtime nodemailer usage; esbuild compiles it fine. Don't
waste time chasing it. If a tsc gate is ever added, fix all `pool:false` call sites
together with an explicit `SMTPTransport.Options` cast.
