---
name: Orange/Wanadoo risk rollout
description: Non-obvious safety boundaries between baseline cooling, observation, and enforcement.
---

Observation mode preserves the existing sliding 15-day complaint-IP cooling period; “no audience change” means no additional scoring or probation filter beyond that established suppression baseline. Once enforcement is active, scoring, campaign-counter, or audit infrastructure failures must stop the send path rather than silently admit the risk cohort.

Production enforcement was calibrated and activated on 2026-09-08 with 10% deterministic probation exposure, a 0.45% target, and a 0.60% hard threshold. Two independent 30-day historical windows favored 10% over higher exposure: it maximized the number of campaigns below the hard threshold, while global projected complaint rates remained far below the target.

**Why:** The complaint cohort also contains valuable clickers, so permanent exclusion or uncalibrated filtering destroys value. Conversely, enforcement that fails open during a database/bootstrap problem defeats the campaign safety guarantee.

**How to apply:** Keep the calibrated 10% production exposure unless a new historical/live analysis justifies changing it. Use observation for new policy changes, retain deterministic decisions and auditable batches, and treat missing individual evidence as safe while treating unavailable enforcement infrastructure as a send-stopping error.