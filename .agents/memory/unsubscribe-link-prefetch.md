---
name: Unsubscribe link prefetch false positives
description: Why GET on the footer unsubscribe URL causes false unsubscribes + inflated stats
---

The footer unsubscribe link `GET /u/:token` (server/routes/tracking.ts) executes a
REAL unsubscribe directly — it enqueues an unsubscribe tracking event, which sets
`subscribers.suppressed_until` and the campaign's unsubscribeTag. Email clients and
their security proxies auto-prefetch links via GET with no human intent.

Observed in prod ("Caroll" campaign): false unsubscribes traced to Google
(142.250.x / 74.125.x / 192.178.x, UA "Android 10; K") and Apple/Cloudflare
(104.28.x). Each prefetch = one real unsubscribe → false unsubscribes and inflated
unsubscribe stats. The 7-day cooling-off itself worked correctly (no sends after the
window); the problem is spurious unsubscribes, not leakage.

**Why:** RFC 8058 one-click is `POST /u/:token` — that is the legitimate
human/list-unsubscribe path. Mutating on GET violates HTTP safety and is exactly
what link scanners / prefetchers trigger.

**How to apply:** If revisiting unsubscribe accuracy, make `GET /u/:token` render a
confirmation page (no mutation) and mutate only on `POST`. As of 2026-07 this is NOT
fixed — the user opted to extend the cooling-off window (7 → 21d,
`UNSUBSCRIBE_COOLING_OFF_DAYS` in server/config/suppression.ts) instead.

Related: a per-IP unsubscribe blocklist exists (`BLOCKED_UNSUBSCRIBE_IPS`, same config
file) that BCK-tags subscribers whose unsubscribe came from a proven-spurious IP
(185.187.30.19 → 3 397 false unsubscribes, retro-tagged in prod 2026-07). CAUTION:
it applies to the RFC 8058 POST path too — never blocklist Google/Apple/Microsoft
provider ranges or legitimate one-click unsubscribes get permanently excluded.
