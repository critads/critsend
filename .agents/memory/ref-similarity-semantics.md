---
name: Ref-similarity semantics
description: Product intent behind exact-case refs and the special DEL marker in similar-to segments.
---

Similarity must use subscriber refs with exact-case matching. `DEL` can never be the source or a suggested/resolved ref, but a subscriber carrying `DEL` remains eligible through any other selected ref.

**Why:** The product requirement explicitly distinguishes excluding the `DEL` ref value from globally excluding subscribers that also carry useful refs.

**How to apply:** Preserve this distinction in analysis, previews, campaign audience compilation, exports, and any future ref-similarity ranking changes.