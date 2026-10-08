---
name: Newsletter HTML visibility heuristics
description: What counts as "hidden" when reducing campaign HTML to visible text; why image analysis is required for AI features.
---
Rule: when extracting visible text from campaign HTML, only `display:none`,
`max-height:0` and `visibility:hidden` mean hidden. `font-size:0` is NOT a
hiding signal.

**Why:** MJML/Klaviyo templates put `font-size:0px` on every visible column
wrapper (30+ per newsletter). Treating it as hidden removed the whole body and
made the AI preheader feature answer "not enough text" on a newsletter full of
offers (operator-reported, October 2026).

**How to apply:** any new AI/analysis feature reading campaign HTML should
reuse `extractNewsletterText` + `collectImageCandidates` (preheader service)
rather than re-implement the heuristics. Hidden mobile/desktop variants
duplicate content: keep text and dedupe lines, do not drop blocks. Many
newsletters are picture-only (offer, prices, dates baked into visuals): the
operator expects images to be analysed as much as text, so pass them to the
model (vision) and only refuse when there is neither text nor a loadable image.
Already-hosted images may be relative `/campaigns/…` or `/i/…` paths → read
from IMAGES_DIR; remote ones must go through the SSRF-guarded downloader.
