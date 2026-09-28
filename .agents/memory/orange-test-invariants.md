---
name: Orange Test invariants
description: Rules any change to the per-MTA Orange deliverability test (send + IMAP checker) must keep, and why dev cannot exercise real MTAs.
---

## NOT RECEIVED is never a clock decision
A waiting test may only be closed as NOT RECEIVED after a mailbox check that
*started* after its deadline came back clean, or after the grace period when
the mailbox is unreachable/disabled. Any new closing path (manual "give up",
worker-side sweep) must keep that gate.
**Why:** Orange/MTA queues deliver hours late; an expiry that runs before the
last look races a hit that is already in flight and records a false verdict.
**How to apply:** stamp clean misses with the claim time, not the session end;
never expire on `deadline_at <= now` alone.

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
