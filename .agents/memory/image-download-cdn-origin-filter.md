---
name: Image downloads redirected to a homepage by the asset host (Tradedoubler vht)
description: Why every image of a creative can fail to rehost in prod while the same URLs work from a browser and from dev; how to read the log and unblock. Read when the wizard flags all images of one creative as external after processing.
---

# Asset hosts that filter the production server

Rule: when the `[Image download] Failed: <url> - unsupported content type` line names a *site
homepage* (e.g. `https://www.tradedoubler.com/`) instead of the image URL, the asset host answered
the image request with a 3xx to its homepage. The downloader followed it, got HTML and refused it.
The logged URL is the final hop, so the original `<img src>` host is invisible in the log — check
the creative's HTML for the real host.

**Why (2026-11-01, Jet tours creative, `vht.tradedoubler.com` → CloudFront → Apache origin):**
all 16 images were redirected to the homepage when fetched from the prod app server (Hetzner),
while the identical downloader code from Replit, even pinned to the same Helsinki CloudFront edge,
got 16/16 `200 image/*` and a normal 404 for a nonexistent path. A `curl` from prod returned 200
only because that file was already a CDN cache hit; the filter sits behind the cache (origin side),
keyed on the requesting server (datacenter IP and/or non-browser request shape — not yet separated).

**How to apply:**
- Unblock a live campaign: fetch each image once from a non-filtered network (Replit dev is enough),
  which caches them at the regional CloudFront edge; "Re-process images" in prod then succeeds
  (confirmed by the owner). Only works for hosts fronted by a shared CDN cache, and only until the
  cache expires.
- Durable fix still open: run the discriminating test from prod on a never-cached path
  (`curl --http2`, `curl --http1.1 -H Accept:`, and a bare Node `https.request` with the downloader's
  headers). If only Node is redirected → send browser-like headers (Accept, Accept-Language, h2);
  if all are redirected → the server IP is refused, route image downloads through another egress.
- Tracking pixels (`impfr.tradedoubler.com/imp?...`, text/html) can never be rehosted; they must be
  removed, not retried.
