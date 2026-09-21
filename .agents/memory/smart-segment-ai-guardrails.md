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
each cell bounded by the worst complaint rate among the tier cohort and the ref cohorts of the
ref blocks used; unattributed subscribers at the worst measured rate, (c) authoritative
`blocksUsed` derived from macros actually expanded in that segment, never from the model's
declaration, (d) model text (name/rationale/warnings) stripped of every figure — the server
writes the numeric explanation itself.

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
MTA), resets on change, drops late responses, disables « Créer » unless params still match.

**Why:** an analysis made for another name/cap/pre-draft context could otherwise be attached to
the current draft (500 ms debounce + un-fenced mutation results made this reachable).
