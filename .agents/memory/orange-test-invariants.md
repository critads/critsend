---
name: Orange Test invariants
description: Rules any change to the per-MTA Orange deliverability test (send + IMAP checker) must keep, and why dev cannot exercise real MTAs.
---

## NOT RECEIVED is never a clock decision
A waiting test may only be closed as NOT RECEIVED after a mailbox check that
*started* after its deadline came back clean. If no clean post-deadline look
exists once the grace period is over (mailbox unreadable, feature disabled,
checker down) the test closes as `not_checked` — a terminal STATUS with a NULL
verdict, deliberately not a verdict value, so verdict maps/stats stay untouched
and "latest verdict" logic skips it. Any new closing path (manual "give up",
worker-side sweep) must keep both gates.
**Why:** Orange/MTA queues deliver hours late; an expiry that runs before the
last look races a hit that is already in flight and records a false verdict —
and a NOT RECEIVED recorded while nothing was checked reads as "MTA blocked"
to operators (the incident that motivated the health indicator).
**How to apply:** stamp clean misses with the claim time, not the session end;
never expire on `deadline_at <= now` alone; UI must present `not_checked` as
"nothing known", never as a verdict.


## A miss is only clean when every search for it actually ran
The reader catches refused searches (Message-ID, text, sender fallback) as
session warnings; a test that is absent from the hits because one of *its*
searches failed is reported as incomplete and must be recorded as a failed
check (with the reason), never as a clean look. A session in which no lookup
completed at all counts as a mailbox failure (class IMAP) for the health row.
**Why:** an IMAP server that accepts the login but rejects searches would
otherwise look like a clean empty mailbox and close tests as NOT RECEIVED —
the exact false verdict the health indicator exists to prevent (caught in
review, not in production).

## Mailbox health lives in the DB, keyed by the configured mailbox
The checker records every IMAP session outcome (success / classified failure
streak) in a row keyed by `config.mailbox`, and the hourly "unreadable" warn
throttle is a compare-and-set on that row — not an in-process timer.
**Why:** two PM2 web instances plus restarts; an in-memory throttle would warn
twice per hour or forget the streak, and the /mtas banner must survive a
redeploy. Only sessions that actually ran are recorded (a tick with nothing
due says nothing about the mailbox).

## One IMAP session across all instances
The claim (SKIP LOCKED) only serialises the row hand-out; the mailbox session
must run under the cross-instance lease (transaction-scoped advisory lock on a
dedicated connection with `idle_in_transaction_session_timeout` = tick budget,
so a hung process cannot keep the lock). The losing instance skips silently.
**Why:** two PM2 web instances would otherwise open parallel sessions to the
same mailbox and could re-claim a row while the first session is still open.
The lease's checked-out pg client must own an `'error'` listener for its whole
life: when the idle-in-transaction timeout fires, the client emits the FATAL
and then a socket-end error, and an unlistened `'error'` is an uncaught
exception — the safety net would hit the process instead of just the lease.
`release()` after such a loss must discard the client (`release(true)`).

## Claim order is a set, not a sequence
`claimDue`'s `ORDER BY next_poll_at … LIMIT` decides which rows fit under the
limit; `UPDATE … RETURNING` hands them back in planner order. Nothing may rely
on the returned order (the in-memory mirror returning them sorted is a
superset, not the contract).

## Control value = most recently SENT test
Card badge and history are ordered by send time; a late verdict on an older
test never overrides a newer test, and a refused hand-off (`failed`) is shown
next to the last sent test's verdict, never as the verdict itself.

## Dev cannot reach real MTAs
Prod MTA passwords are encrypted with a key dev does not have
(`Unsupported state or unable to authenticate data`) and the sending hosts are
unreachable from the sandbox. Exercise the send path with a throw-away local
SMTP sink MTA (delete it afterwards); the mailbox path is only verifiable in
prod once Orange IMAP access / an app password is enabled.
