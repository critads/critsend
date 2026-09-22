---
name: Campaign exclusion segments (multi)
description: Contract for campaign exclusion segments — canonical array table, legacy single column is a mirror, FK RESTRICT rationale, bootstrap-based rollout, lock-time re-validation.
---

# Rule

`campaign_exclusion_segments` (ordered rows) is the canonical representation of a campaign's exclusions; `campaigns.exclude_segment_id` is only a mirror of position 0 for older readers. Every reader (sender, warm-start planner, similarity snapshot, copy, preflight, list/detail) must consume the array; a path that reads only the legacy column silently drops exclusions 2..n.

**Why:** Multi-exclusion was added on top of the single-column design (Sept 2026). Keeping the mirror avoided a big-bang rewrite, but it means the column can never be treated as the source of truth again.

**How to apply:**
- Request contract: canonical `excludeSegmentIds[]` wins over legacy `excludeSegmentId`; an ABSENT key on PATCH leaves exclusions untouched, `[]` clears them. Compare exclusion lists as sets (order carries no meaning); audience order does matter.
- Any exclusion id that is also an audience id = always-empty audience: routes answer 400, repository paths return `[]`/0, warm planner throws "cannot be compiled". Re-validate this under the campaign row lock too — the pre-lock check uses a snapshot a concurrent PATCH can invalidate.
- `/send` rewrites audience+exclusion rows from the pre-lock snapshot when the body omits them; if the locked rows differ, it must 409 rather than silently revert a concurrent edit.
- Segment FK on exclusion rows is `ON DELETE RESTRICT` (same as audience rows). A running sender keeps the exclusion ids in memory and `compileSegmentWheres` silently omits segments it cannot find, so a cascaded delete would let later batches reach explicitly excluded subscribers. The bootstrap rewrites a CASCADE constraint left by an earlier build; segment DELETE returns 409 on FK violation.
- Schema rollout goes through the idempotent startup bootstrap (`campaign-segments-bootstrap`), not migrations: prod (Hetzner, PM2) has no migration runner and drizzle push is dev-only. The one-time backfill from the legacy column only seeds campaigns with zero exclusion rows.
- Tests that mock `getCampaign`/`attachSegmentIds` must provide three `db.select` results (campaign, audience rows, exclusion rows) and use `resetAllMocks` to avoid once-value leakage. Segment tag operator in rules v2 is `has_tag`.
- DB-backed vitest suites (pressure-guard, stuck-campaign) share the dev DB with the running workflow; guardian/pressure workers insert `campaign_jobs` for test campaigns and break cleanup (FK 23503) — stop the dev server before trusting a failure there.
