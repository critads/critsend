# Memory Index

- [Campaign claim starvation after redeploy](campaign-claim-starvation.md) — newest campaigns stuck at sent=0 after deploy = worker PM2 process didn't reload the fairness ordering, or JOB_FAIRNESS_PROMOTE_MIN set too high.
- [Prod DB access](prod-db-access.md) — query prod Neon via `npx tsx` importing server/db; executeSql hits DEV only.
- [Hetzner S3 throttle handling](hetzner-s3-throttle.md) — 503 SlowDown mitigation: adaptive retry + deferred upload to worker job.
