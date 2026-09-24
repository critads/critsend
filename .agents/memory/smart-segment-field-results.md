---
name: Smart segment field results (first production week)
description: What the first 24 production smart-segment analyses (21–24 Sept 2026) revealed about calibration blind spots — read before touching the complaint projection, calibration-send selection or the cap logic.
---

# Smart segment field results (audit of 2026-09-24)

## Complaint capture is MTA-dependent — a 0 in the history is often "unmeasured", not "safe"
Rule: never treat a 0-complaint calibration send as evidence of a 0 % complaint rate. Complaint events are
complaint-IP opens; on some MTAs they are virtually never captured (Kammaspeed: ~0.003 % of Orange/Wanadoo
sends vs 0.09–0.28 % on Rndaserver/Mayesale/Mahlesoldes/Rndamailing over the same 35 days), and US-family
sends carry no Orange/Wanadoo recipients at all.

**Why:** the evidence picks the 3 newest brand sends ≥ 5k delivered regardless of MTA/family, so Histoire d'Or,
Petit Bateau, Club Med, Transavia and Dim were projected at 0.000–0.003 % complaints; the real sends on
capturing MTAs came out at 0.10–0.23 % (HO: 0 projected → 152 actual). Where the history was comparable, real
smart sends still ran 2–3× the projected complaints (Belambra, Mobilier de France) and 4–6× the brand's
usual per-Orange-recipient rate. The 0.45 % cap therefore never bound.

**How to apply:** calibrate complaints on sends of the planned MTA (params.mtaId — then it must enter the
analysis identity), or on capturing MTAs only; floor a 0-observation cohort (rule of three / vertical
baseline); express the projection per Orange/Wanadoo recipient as well, since that is the probation metric.

## Smart audiences skew Orange/Wanadoo and unsubscribe more than the brand's usual sends
Observed: 74–83 % Orange/Wanadoo share for Dyson/Transavia/Club Med/Simone Perele vs 44–62 % in their own
history; unsubscribe rates 2–5× the brand history (HO 1.02 % vs 0.19 %, Belambra 1.04 % vs 0.23 %). In smart
sends Orange/Wanadoo recipients click 4–18× more often than other domains (manual sends: 2–5×) — the click
tiers concentrate that population even with the complaint-IP exclusion. Click projections themselves were
within ±30 % (two under, one over). The feature projects neither unsubscribes nor Orange share.

## Usage pattern
Operators iterate target/cap several times per brand within minutes (10 of 24 runs were re-runs); every run
redoes the full evidence (27–58 s, 24–37 queries) although evidence does not depend on target/cap. Nested
proposals (recommendation ⊂ similar-brands) are frequently BOTH attached to one campaign, so the union is the
wide one and the recommendation's projection is moot.
