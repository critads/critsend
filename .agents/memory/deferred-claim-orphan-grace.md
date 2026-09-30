---
name: Deferred-drain claims vs orphan grace
description: Why the pressure-guard drain must re-stamp sent_at at claim time and count from transitioned rows.
---

A deferred `campaign_sends` row keeps `sent_at` from the moment it was deferred (hours earlier). The orphaned-sends reconciler closes any `attempting` row whose `sent_at` is older than its grace (1 h) — so a claim that only flips `pending → attempting` hands the hourly sweep rows that are being delivered right now.

**Why:** In-flight rows closed as failed/ambiguous under a drain wave are delivered mails recorded as failures, and counters bumped from in-memory id lists then diverge from the rows (the finalize `WHERE status='attempting'` matched fewer rows).

**How to apply:** Any claim of previously-parked rows must refresh the timestamp the orphan sweep keys on (and keep `first_deferred_at` as the aging anchor), and every finalizer must derive counters/SSE deltas from `RETURNING` rows, logging when some ids no longer transitioned.
