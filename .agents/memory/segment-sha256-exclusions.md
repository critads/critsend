---
name: Segment SHA-256 exclusions
description: Canonical normalization and audience-safety rules for uploaded segment exclusion hashes.
---

Uploaded segment exclusion hashes use `SHA-256(UTF-8(email.trim().toLowerCase()))`. Subscriber-derived hashes must be calculated transiently and never persisted.

**Why:** A different normalization produces silent false negatives, and applying the exclusion only to preview/count would still allow excluded recipients into real sends.

**How to apply:** Every audience path must enforce the exclusion server-side. For multi-segment unions, apply each segment’s own hash exclusion inside that segment’s branch before OR-composing the branches.