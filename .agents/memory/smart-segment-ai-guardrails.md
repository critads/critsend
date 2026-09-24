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
`smartSegmentAnalysisIdentity` (immediate name, campaign, MTA, family, target, cap rounded at
1e-6, override, similar refs), resets on change, drops late responses, disables the create
buttons unless params still match. The MTA IS part of the identity since complaint capture
depends on the sending MTA (calibration sends are ranked by it). A
hand-typed brand must stay editable and is dropped when the campaign name changes (otherwise it
silently keeps precedence over detection with stale refs/tags/history).

**Why:** an analysis made for another name/cap/pre-draft context could otherwise be attached to
the current draft (500 ms debounce + un-fenced mutation results made this reachable).

## 3a. Proposals of one analysis are NESTED audiences: attach one, never several
Rule: the 2–3 proposals overlap (recommended ⊂ wider ⊂ with similar brands), so a campaign holds
at most ONE of them. `materialize` takes `attach` + exactly one index (2+ with attach ⇒ 400);
server-side attach on a draft detaches the analysis' sibling segments in the same transaction
under the campaign row lock and re-mirrors the legacy `campaigns.segment_id` to the
lowest-position row; the response lists `detachedSegmentIds`; « Créer sans attacher » only
creates. The wizard mirrors this itself (drops the other created siblings from its selection)
because for a new/unsaved campaign the server cannot attach at all.

**Why:** the first « Créer les deux/trois » button attached nested segments together; the
campaign then sent to the union (= the widest one) while the operator believed the recommended
one was in use, and the badge counters/projection comparison were meaningless.

## 3b. Evidence cache lives inside the evidence JSON (no migration)
Rule: the dossier carries `evidenceKey` = `smartSegmentEvidenceIdentity` (brand/family/similar
refs/excluded campaign/MTA + a FORMAT tag) and, when reused, `reusedFrom`. A param-only re-run
(target/cap) within the reuse window copies the latest ORIGINAL dossier (`reusedFrom IS NULL` —
a copy is never a source, so chains cannot outlive the window) and re-queries only the recent
brand sends; `refresh` always rebuilds. Bump the format tag whenever the dossier's shape or a
measurement changes, or stale dossiers keep being served for the whole window.

**Why:** a cap/target tweak re-scanned the calibration sends (minutes of campaign_sends work)
for a result whose evidence part is identical; operators re-ran 3–4 times per campaign.

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

## 5a. Complaint calibration is MTA-aware; thin cohorts use the rule of three
Rule: every MTA is classified on its 90-day cached counters (delivered < 100 000 ⇒ unknown,
complaint rate < 0,01 % ⇒ blind, else capturing). Blind-MTA sends never calibrate complaints
while a capturing (or unknown) send exists — and that ranking must happen BEFORE any recency
cap (brand history 6, fallback 8), on a cheap `campaigns.mta_id` lookup, within the same
180-day horizon as the floor. When every calibration send is blind, a floor measured on
capturing MTAs (brand → vertical → global, 180 d, cached counters) bounds every projected cell.
A cohort with 0 (or few) observed complaints is bounded by 3 / observed recipients (observed =
un-rescaled sampled rows). The Orange/Wanadoo cohort (`domain_group` axis) gets its own
projected complaint rate; a red OW rate on ≥ 1 000 OW recipients rejects the proposal.

**Why:** the first production week calibrated a brand on Kammaspeed sends (0 complaints on
8 M delivered = blind), projected 0,000 % and sent; the real complaints were only visible once
the same audience went through a capturing MTA. Old capturing sends beyond 180 d are not
preferred: they would calibrate clicks on stale behaviour, and the floor uses the same horizon.

## 6. Raw SQL statements: every bound parameter must be referenced
Rule: a hand-written statement run through the evidence runner must reference every `$n` it
binds (and nothing beyond). Shared fragments take their placeholder numbers as arguments
instead of hard-coding them. The evidence test runner enforces both directions.

**Why:** a recency statement bound the family-domain array it never used; PostgreSQL rejected
it at bind time ("could not determine data type of parameter $5") only in production — the
backtest had substituted literals and the unit tests use a fake runner, so nothing caught it.

**How to apply:** after editing any `*_SQL` constant, run it once against a real database with
typed placeholders (a throwaway pg script in .local/tmp/), not with substituted literals.

## 7. Similar brands: synchronous web-search lookup, strict output, versioned reuse
Rule: the « marques similaires » lookup answers inside the wizard request, so directory load +
web-enabled call + knowledge fallback share ONE deadline capped below the reverse proxy's 60 s
(config max 55 s; a fallback gets only what is left, and is skipped under ~4 s). A model answer
that is not the requested shape (no `marques` array) is AI_BAD_RESPONSE and never persisted —
only an explicit empty list means "no comparable brand". Candidates come only from the brand
directory; invented names are dropped and noted. `webSearchUsed` means a search RETURNED results
(billed attempts can all fail). Model prose is stripped of performance figures (%, €, clics,
plaintes…) but plain numbers stay (« 3 Suisses », age ranges) — a digit-stripper mangles names.

**Why:** two sequential calls with the full timeout each silently exceeded the proxy, a
non-array answer was cached 30 days as "no brands", and `stripDigits` broke real brand names.

**How to apply:** any new synchronous model call in a request path needs an outer deadline
passed down per call; the client query for a billed lookup must never refetch on focus/reconnect
(refresh = new query key nonce, so its retries stay refreshes). The 6 h analysis reuse is keyed
by prompt version too: a prompt change must not be invisible until the reuse window expires.
When the operator selected similar brands, the proposal must hold a recommendation without them
AND, last, a « avec marques similaires » segment on EVERY model attempt; after the last attempt the
analysis fails (422, with « retirez des marques similaires ») — never a success with a note. The
web-search `max_uses` is a per-answer ceiling: a paused turn that spent it is not continued.
