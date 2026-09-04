---
name: Calendar live-interval semantics
description: Product meaning of open and paused campaign intervals in the MTA calendar.
---

Only a campaign with status `sending` is an open calendar interval. Its visible
end is the single server-issued observation instant shared by the API query and
the client render. A paused campaign ends at its last actual send (or other
recorded terminal fallback) rather than extending to the observation instant.

**Why:** The calendar represents real MTA activity. Extending a paused campaign
through the present would falsely show an idle MTA as occupied, while closing a
live sending campaign at its last cached send would make long-running campaigns
disappear from later calendar periods.

**How to apply:** Preserve the shared observation instant whenever calendar API
or rendering logic changes. Treat new non-sending statuses as closed unless the
product explicitly defines them as actively consuming MTA capacity.