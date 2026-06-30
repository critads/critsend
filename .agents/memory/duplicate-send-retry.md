---
name: Duplicate sends — ambiguous SMTP outcomes must be terminal
description: Why a recipient gets the same campaign twice (different message-ids), and the invariant every send/finalize path must uphold to prevent it.
---

# Duplicate sends: never resend an ambiguous SMTP outcome

## Root cause (durable)
`campaign_sends.status='failed'` does **NOT** mean "not delivered." SMTP is
**at-least-once**: a timeout / connection drop **after** the message body (`DATA`)
was sent, a post-send bookkeeping exception, or a crash-orphaned `attempting` row,
all land as `failed` even though the MTA may have already delivered. Any path that
re-sends such a row produces a duplicate: **same campaign, same recipient, different
message-id** — exactly what anti-spam FBL reports as duplicates. (Incident: an
anti-spam filter reported duplicate-receivers massively over-represented among
complainers, even though the visible `retry_count>=1` rate was low — the invisible
retries, inline-retry + DELETE-then-re-reserve, hid the true rate.)

## Design decision (durable — why it's shaped this way)
Keep `status ∈ {pending,attempting,sent,failed}` UNCHANGED and add ONE nullable
discriminator column `smtp_outcome_class ∈ {delivered, pre_data_retryable, ambiguous}`.
- **ambiguous** ≡ `status='failed'` + `smtp_outcome_class='ambiguous'` → **terminal, never resent**.
- **retryable** ≡ `status='failed' AND smtp_outcome_class IS DISTINCT FROM 'ambiguous'`
  (legacy `NULL` counts as retryable → backward compatible).
- **Why no new status VALUES** (the original plan proposed `uncertain`/`failed_retryable`):
  ~10 readers of `status` (stats, counters, UI, SSE, exports) would silently break.
  A discriminator column is invisible to them.
- Classifier default for post-`DATA`/unknown errors (timeout, reset, ESOCKET,
  exception) is **ambiguous** (the safe default). `pre_data_retryable` only on PROOF
  the body was never accepted (ECONNREFUSED, auth fail, 4xx/5xx on MAIL/RCPT, or
  error before `sendMail`). A successful `sendMail` resolve is authoritative = `sent`
  even if later bookkeeping throws.

## THE structural invariant (most important lesson)
`campaign_sends` is finalized or resurrected by **MANY independent paths**, not one.
Every path that (a) finalizes a send, (b) flips `attempting→failed`, or
(c) flips/deletes `failed→pending` MUST treat ambiguous as terminal, or it
re-introduces duplicates. Known paths that must stay in lockstep:
- **TWO full send paths**: `campaign-sender.ts` (main loop + retry phase) **and**
  `pressure-guard-worker.ts` drain (deferred sends — easy to forget; it has its own
  finalize + auto-requeue).
- `attempting→failed`: `orphaned-sends-reconciler.ts` Pass A **and** the startup
  stale-attempting cleanup in `workers.ts` (both must stamp `ambiguous` when guard ON).
- `failed→pending`/retry: `autoRequeueCampaignFailed`, `getFailedSendsForRetry`,
  `markSendForRetry`/bulk, the `/retry-failed` route, `resetOrphanedFailedSends`
  (DELETE-then-re-reserve), and the **manual** `scripts/requeue-failed-campaigns.ts`.
- The completion gate (`completeCampaignIfDrained`) must treat ambiguous as terminal
  so the campaign can finish without waiting to "retry" ambiguous rows.

## How to apply
All of it is gated behind `ZERO_DUP_SEND_GUARD` (OFF by default → **byte-identical**
to legacy; conditional drizzle fragment pattern `guardOn ? sql\`, ...\` : sql\`\``).
Guard truth-table test: `tests/send-guard.test.ts`. When adding any new send or
requeue path, route ambiguous → `failed`+`smtp_outcome_class='ambiguous'` and exclude
it from selection with `smtp_outcome_class IS DISTINCT FROM 'ambiguous'`.
**Operational caveat:** do NOT toggle the guard OFF after it has produced terminal
ambiguous rows unless you accept that legacy retry semantics will resend them.
