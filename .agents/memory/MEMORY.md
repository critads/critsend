# Memory Index

- [Campaign claim starvation after redeploy](campaign-claim-starvation.md) — newest campaigns stuck at sent=0: TRIAGE by deferred_count + job error first (pressure-deferred vs slot-saturation vs ghost) — bumping created_at can't free a saturated slot.
- [Deploy zero-downtime & health gating](deploy-zero-downtime.md) — critsend-web needs PM2 cluster+wait_ready for zero-downtime reload; authoritative readiness = /api/health/startup body status:"ready", not the boot-line grep.
- [Prod DB access](prod-db-access.md) — query prod Neon via `npx tsx` importing server/db; executeSql hits DEV only.
- [Hetzner S3 throttle handling](hetzner-s3-throttle.md) — 503 SlowDown mitigation: adaptive retry + deferred upload to worker job.
