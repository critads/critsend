---
name: Complaint-IP temporary suppression contract
description: Complaint-IP opens remain complaint analytics while imposing a renewable 15-day subscriber cooling-off period.
---
Opens attributed to the configured complaint IP remain complaint analytics events and add no permanent tag, but temporarily suppress the subscriber from every campaign for 15 days after the latest detection. A later existing deadline must never be shortened.

**Why:** the operator replaced the former counting-only policy with a reversible cooling-off period, while explicitly rejecting permanent BCK/STOP-style exclusions.

**How to apply:** new detections extend from event time and recent history is reconciled from both legacy open and current complaint rows. Open-by-IP consumers must count both types. FBL/webhook complaints without that IP remain unchanged.
