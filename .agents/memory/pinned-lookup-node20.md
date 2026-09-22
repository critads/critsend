---
name: Pinned DNS lookup on Node ≥ 20
description: Why a custom http.request lookup that pins an address must honour options.all, and why fixtures must use a real hostname. Read before touching the image downloader's SSRF pinning or writing network fixtures.
---

# Custom `lookup` pinning on Node ≥ 20

Rule: a custom `lookup` passed to `http(s).request` / `net.connect` must answer in the shape Node
asks for — `callback(null, [{ address, family }])` when `options.all` is truthy, `callback(null,
address, family)` otherwise. Test fixtures for it must keep a real (unresolvable) hostname in the
request options and pin the fixture's address through the callback; an IP-literal hostname makes
Node skip the lookup entirely, so the callback is never exercised.

**Why:** the anti-SSRF image downloader (Sept 2026) pinned the validated address by answering a
bare string. Node ≥ 20 enables autoSelectFamily (Happy Eyeballs), which calls the lookup with
`all: true` and destructures the answer as an array — every real image download failed with
"Invalid IP address: undefined" for five days while the suite stayed green, because the fixture
connected to `127.0.0.1` directly.

**How to apply:** any outbound connection that pins an address (image downloads, MTA transfers,
future webhooks) goes through the same helper; a behavioural test with a non-IP hostname under
both `net.setDefaultAutoSelectFamily(true|false)` is the guard. Reproduce a "nothing downloads"
report first with a one-off tsx script calling `downloadImage` on a real URL — it is a 10 s check.
