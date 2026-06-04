---
name: Campaign status-flip guards
description: Why any "back to sending" write path must check current campaign status first
---

# Rule
Any DB write that flips `campaigns.status` back to `'sending'` (failed-send auto-requeue, manual retry-failed, requeue, ghost/mid-flight sweep) MUST gate on the campaign currently being `'sending'` (or otherwise eligible). Never flip unconditionally based only on "there is work to retry".

**Why:** The bulk sender's `shouldStop` flag lags real status by up to one `STATUS_CHECK_INTERVAL` (~10s). When an operator clicks **End** (`POST /api/campaigns/:id/end` → status `completed`) or **Pause** (status `paused`) while a sender pass is mid-flight, the pass can reach its finalization auto-requeue with a stale `shouldStop=false`. If the requeue path has no status guard, it sets status back to `sending` + enqueues a fresh `campaign_jobs` row → the campaign "auto-restarts" right after the operator ended it. Reported in prod for high-volume campaigns that always have some failed sends.

**How to apply:** The shared `autoRequeueCampaignFailed` (called by both the bulk sender finalization AND the pressure-guard worker) is the resurrection point — gate it on current status, not just "failed rows exist". The CAS completion path and the ghost-sweep already gate on `status='sending'`, so the auto-requeue was the one unguarded hole. Residual: under a tight interleave the requeue's reset-to-pending can run without the status flip (harmless data-hygiene drift, no restart). Self-hosted on Hetzner/PM2 — fixes here only take effect after a deploy.
