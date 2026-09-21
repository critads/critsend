---
name: Smart segment AI guardrails
description: Invariants of the AI-assisted segment composer — fail-closed model output, cluster-safe job admission, strict materialisation binding. Read before touching smart-segment-* services, routes or the wizard.
---

# Smart segment AI guardrails

## 1. Model output is fail-closed: inclusions only through calibrated blocks
Rule: the model may include subscribers ONLY via `{"block":"<id>"}` macros. Hand-written
conditions are accepted solely for exclusion operators, and the un-expanded rule tree must
structurally imply block membership (macro ⇒ yes, raw condition ⇒ no, AND ⇒ any child,
OR ⇒ every child). Anything else is rejected and the reason is fed back for one retry.

**Why:** the projection applies measured cohort rates to the blocks' populations. A raw
inclusion (e.g. `has_ref` on the brand's core refs, `clicked_campaign`, `ends_with`) has no
measured cohort; projecting it at the 0-click "floor" let the model re-express a risky
block as raw DSL and pass the complaint cap. An allowed exclusion under an OR is an
inclusion in disguise (widens beyond the blocks) — the operator allowlist alone is not enough.

**How to apply:** any new operator, block, or prompt change must keep: (a) inclusions = macros,
(b) the projection computed from the EXACT recount of the final rules partitioned by clicker
tier (disjoint cells — blocks nest, 6+ ⊂ 4+ ⊂ 1+, so summing block capacities double counts),
each cell bounded by the worst complaint rate among the tier cohort, the selected family's
own cohort (audiences are family-restricted; tier rates are all-family) and the ref cohorts of
the ref blocks used; unattributed subscribers at the worst measured rate, (c) authoritative
`blocksUsed` derived from macros actually expanded in that segment, never from the model's
declaration, (d) model text (name/rationale/warnings) stripped of every figure — the server
writes the numeric explanation itself.

## 1a. Recent-send exclusion = the ≤ 6 NEWEST brand sends, not the whole window
Rule: the evidence keeps the newest matches only (rows ordered by first send desc, sliced after
the exact brand-token filter); the same list feeds the prompt, the mandatory injection and the
coverage check. **Why:** excluding every send of the 30-day window over-excluded and distorted
the recount for brands sending several times a week.

## 1b. Model call timeouts must cover the body
Rule: keep the abort timer armed until the response body is fully consumed; clear it in a
`finally`. **Why:** headers can arrive fast while the body stalls; a job waiting on `text()`
forever pins one of the two global analysis slots.

## 2. Job admission is DB-only (prod runs a PM2 cluster)
Rule: reuse-window lookup, the global concurrency cap, and the row insert happen in one short
transaction under `pg_advisory_xact_lock`; liveness = `heartbeat_at` (10 s beat, 60 s stale),
swept by a janitor and at boot. Never use process memory or session-level advisory locks.

**Why:** two cluster instances each believed they were alone (in-memory counters) and PgBouncer
transaction pooling breaks session locks. Sweeping by stale heartbeat (not by owner) keeps a
legit run alive across a PM2 reload overlap; worst-case visibility of an interrupted row ≈ 90 s.

## 3. Materialisation binding is strict
Rule: server-side attach only when the analysis was computed for the exact same non-null
campaign id; unbound analysis ⇒ segments created, `attached:false`, wizard attaches through its
own save path; two different ids ⇒ 409. The wizard ties the shown proposal to the shared
`smartSegmentAnalysisIdentity` (immediate name, campaign, family, target, cap, override — not
MTA), resets on change, drops late responses, disables « Créer » unless params still match. A
hand-typed brand must stay editable and is dropped when the campaign name changes (otherwise it
silently keeps precedence over detection with stale refs/tags/history).

**Why:** an analysis made for another name/cap/pre-draft context could otherwise be attached to
the current draft (500 ms debounce + un-fenced mutation results made this reachable).

## 5. Non-active (lapsed / dormant) contacts are never projected at the actives' rates
Rule: a non-active band (no open/click in 60 days) is projected only from a reliable recency
cohort — reliability judged on recipients actually OBSERVED, not on sample-rescaled effectives —
using the lowest implicated CTR and the worst implicated complaint rate. Without such a cohort
the dedicated blocks are omitted and any non-active contacts inside a wider block are carved out
at CTR 0 / worst measured complaint rate. There is no axis-wide fallback for recency.

**Why:** the recency axis is dominated by actives; blending would give dormant contacts the
actives' CTR. Brand sends target engagement-filtered audiences, so their own non-active cohorts
are almost never reliable — the pool of recent sends of every brand (global markups) is the usual
source, and the pool is best-effort under the evidence budget (omit, never fail the analysis).

**How to apply:** audience recency = live `last_engaged_at` bands; calibration recency = last
activity BEFORE the send. Similar-brand refs are an operator selection validated server-side,
part of the analysis identity, and removed from the vertical pool (no double counting).
