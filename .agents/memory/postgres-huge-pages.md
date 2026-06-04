---
name: PostgreSQL huge pages — reading the metrics
description: How to verify PG is actually using reserved huge pages; avoids a misdiagnosis.
---

# Verifying PostgreSQL huge-page usage

When PG uses huge pages for `shared_buffers`, it reserves all pages at startup but
**faults them in lazily**. So `/proc/meminfo` shows most of them under
`HugePages_Rsvd` (which is counted *inside* `HugePages_Free`), NOT as a drop in
`HugePages_Free`.

**Do NOT** conclude "PG fell back to 4KB pages" just because `HugePages_Free` is
still high right after start. The correct check:

    (HugePages_Total - HugePages_Free) + HugePages_Rsvd  ==  shared_memory_size_in_huge_pages

(i.e. faulted + reserved == what PG asked for, from `SHOW
shared_memory_size_in_huge_pages`).

**Why:** On the critsend dedicated DB box (AX162-R, 64GB shared_buffers, 33581
2MB pages needed, reserved 33837 via `vm.nr_hugepages`), `HugePages_Free` stayed
~33116 after start, which *looked* like a fallback. It wasn't — `HugePages_Rsvd`
was 32860, so 721 faulted + 32860 reserved = 33581 = fully mapped.

**Definitive test:** set `huge_pages = on` and restart. With `on`, PG refuses to
start if it can't get its huge pages, so a clean start proves they work. Production
keeps `huge_pages = try` (graceful fallback if a reboot can't reserve pages).

**LimitMEMLOCK:** systemd default is 8MB; raising it to `infinity` via a
`postgresql@17-main.service.d/override.conf` drop-in is the documented prerequisite
for huge pages, though in this case PG mapped them even before the bump.
