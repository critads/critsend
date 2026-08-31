---
name: Step-resume cursor and failed-send invariants
description: Why step-limited campaign resumes must preserve failed send rows whenever they preserve the audience cursor.
---

# Step-resume invariants

When continuing or finishing a campaign paused at a step limit, preserve both the
audience cursor and existing retryable failed send rows. Disabling the step limit
must not delete failures behind the cursor; the normal retry phase handles them
after the remaining audience has been enumerated.

**Why:** If a resume keeps the cursor but deletes a failed row from an earlier
step, audience enumeration starts after that subscriber and the retry phase has
no row left to select. The subscriber is silently omitted. Resetting the cursor
would avoid omission but unnecessarily rescans the completed audience.

**How to apply:** Treat step-limit resumes differently from manual/non-step
resumes in orphan-failed cleanup. Any future resume cleanup must consider the
cursor and retry-row lifecycle together, and concurrent resumes must claim the
paused campaign before mutating jobs or sends.