---
name: Duplicate sends from failed-send retry
description: Why the same campaign reaches a recipient twice (different message-ids) — the retry phase re-delivers ambiguous/possibly-delivered "failed" sends.
---

# Duplicate sends: retry-of-"failed" re-delivers already-delivered email

The campaign sender runs a **retry phase** after the main pass: it pulls every
`campaign_sends` row in status `'failed'` and re-sends it over SMTP (fresh
message-id), looping with backoff up to a 12h deadline. `autoRequeueCampaignFailed`
also resets `failed`→`pending` and re-enqueues a fresh job across restarts
(observable via `campaigns.auto_retry_count > 0`).

The flaw: **`'failed'` does NOT mean "not delivered."** SMTP is at-least-once. A row
becomes `'failed'` even when the MTA already accepted+delivered the message:
- SMTP timeout / connection drop **after** DATA (very common under a loaded PMTA) —
  the relay queued/delivered it but we never saw the final 250.
- a post-send exception (the per-recipient `Promise.allSettled` rejecting after a
  successful `sendMail` pushes the id into `pendingFailedIds`).
- crash-orphaned `'attempting'` rows that the orphaned-sends reconciler flips to
  `'failed'`. Its in-code comment claims "marking failed is bookkeeping-only ... no
  risk of duplicate send" — that claim is **false**, because the retry phase and
  `autoRequeueCampaignFailed` both re-send `'failed'` rows.

Re-sending these = same campaign, same recipient, **different message-id** → exactly
what anti-spam FBL reports as duplicates.

**Why:** an anti-spam filter reported ~1.7 spam complaints per recipient (different
message-ids, same campaign, same sending env). Measured on prod (2026-06-30): the
per-campaign duplicate rate is small (~0.2–1.7% of recipients have `retry_count>=1`,
`max retry_count` up to 3), but duplicate-receivers are massively over-represented
among complainers (people who get the same email 2–3x are far likelier to hit
"spam"), which reconciles the low rate with the high complaint ratio.

**Ruled out (not the cause):** duplicate subscriber rows (subscribers.email is
globally UNIQUE); same logical campaign split across multiple campaign_ids
(measured audience overlap between same-brand/same-server same-day sends = 0);
A/B variants (share campaign_id, blocked by `campaign_sends_unique_idx`);
pressure-guard drain vs main sender double-send; resume/guardian re-runs (main pass
reserves via INSERT … ON CONFLICT DO NOTHING, so already-sent/failed rows are not
re-reserved). The pressure guard only **spaces** sends ≥2h apart — it never dedupes.

**How to apply:** any change to retry / orphan-reconcile / auto-requeue logic must
classify the SMTP outcome into delivered / hard-fail / ambiguous, and **only retry
hard pre-DATA failures** (conn refused, auth, 4xx/5xx on MAIL/RCPT/DATA-command).
Outcomes that are ambiguous after the message body was sent, and crash-orphaned
`'attempting'` rows, must move to a terminal status the retry phase IGNORES — never
back to `'failed'`/`'pending'`. Treat a successful `sendMail` resolve as
authoritative even if later bookkeeping throws.
