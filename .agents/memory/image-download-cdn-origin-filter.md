---
name: Tradedoubler weighted DNS redirects
description: Real cause of whole-creative image download failures and how to recognize the independent DNS retry in logs.
---

# Tradedoubler weighted DNS, not origin IP filtering

Rule: do not diagnose `vht.tradedoubler.com` homepage redirects as server-IP filtering
or recommend warming the CDN cache.

**Why:** authoritative Route 53 DNS is weighted (TTL 300 seconds): approximately
90% `d2zs3ok949uz2h.cloudfront.net` serves images, including cache misses, while
10% `vht.tradedoubler.com.cdn.cloudflare.net` redirects every path to
`https://www.tradedoubler.com/`. This is independent of request headers or network.
A cached Cloudflare answer explains whole-creative failures for up to five minutes;
the Helsinki CloudFront cache already contained the images during those failures.
The previous origin-filtering explanation and cache-warming workaround were incorrect.

**How to apply:** recognize `Foreign homepage redirect` or `Cross-host non-image redirect`
logs with `original=`, `final=` and `pinned_ip=`. `Retry via alternative DNS resolver`
identifies the independent resolver and newly pinned address. Retries must share the
original download deadline, validate every returned IP, and never reuse a failed
original address set. Operators can override or disable independent DNS with
`IMAGE_ALTERNATE_DNS_SERVERS`. Direct HTML tracking pixels such as
`impfr.tradedoubler.com/imp?...` must fail without DNS retries.
