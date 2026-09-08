---
name: Orange/Wanadoo risk rollout
description: Non-obvious safety boundaries between baseline cooling, observation, and enforcement.
---

Observation mode preserves the existing sliding 15-day complaint-IP cooling period; “no audience change” means no additional scoring or probation filter beyond that established suppression baseline. Do not activate enforcement until projected tier rates are calibrated from observation/backtest data. Once enforcement is active, scoring, campaign-counter, or audit infrastructure failures must stop the send path rather than silently admit the risk cohort.

**Why:** The complaint cohort also contains valuable clickers, so permanent exclusion or uncalibrated filtering destroys value. Conversely, enforcement that fails open during a database/bootstrap problem defeats the campaign safety guarantee.

**How to apply:** Keep observation as the default for new risk-policy changes, retain deterministic decisions and auditable batches, calibrate before activation, and treat missing individual evidence as safe while treating unavailable enforcement infrastructure as a send-stopping error.