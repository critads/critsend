---
name: Campaign warm-start invariants
description: Correctness rules for prioritized recent-clicker enumeration, crash recovery, resumes, and completion.
---

Warm start is an optional, per-campaign ordering policy. Freeze one recent-clicker snapshot at launch using the immutable half-open 30-day window ending at the planning cutoff. Its exact size is `min(recent clickers, floor(eligible audience × 30%), 50,000)`. Enumerate that snapshot first, then the normal audience while explicitly excluding snapshot members.

**Why:** Recomputing engagement during a send changes ordering after future clicks, while failing to exclude the snapshot from the normal pass can double-count recipients and consume step limits twice.

**How to apply:** Keep audience, exclusion, and the warm toggle immutable after execution begins. Planning errors must reach job retry/backoff rather than silently reverting to normal order.

Cursor and step-count checkpoints must represent one durable boundary. Every fully processed batch—including policy-blocked, pressure-deferred, or replayed batches—advances that boundary only after durable outcomes exist. Deliberate resumes and every automatic replacement worker must increment an execution generation; stale generations may neither send another batch nor publish cursors, counts, pauses, or phase changes.

**Why:** A cursor ahead of its count undercounts step usage; a count ahead of its cursor double-counts on replay. Status checks alone cannot distinguish a replacement worker from its predecessor when both observe `sending`.

**How to apply:** Fence all watchdog, guardian, ghost-recovery, manual-resume, and failed-requeue replacements before exposing the successor. Preserve failed send rows whenever preserving an audience cursor so the retry phase can still reach recipients behind that cursor.

Automatic completion and warm-snapshot cleanup require durable proof that the normal audience iterator reached EOF. Terminal status and cleanup must commit atomically.

**Why:** An empty pending-send queue proves only that currently materialized work drained; it does not prove that the remaining audience was enumerated.

**How to apply:** Gate automatic completion and pressure-tail deadlines on the durable exhaustion marker. Manual End remains an explicit operator override.