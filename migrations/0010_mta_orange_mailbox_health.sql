-- Orange Test: health of the Orange mailbox connection, one row per mailbox,
-- written by the checker after every IMAP session. Lets /mtas tell "the
-- mailbox cannot be read" apart from "the message never arrived", and
-- throttles the "mailbox still failing" warning to once per hour across all
-- web instances (last_warned_at).
-- Mirrors the pgTable declaration in shared/schema.ts; also created
-- idempotently at startup by server/orange-test-bootstrap.ts.
CREATE TABLE IF NOT EXISTS "mta_orange_mailbox_health" (
  "mailbox" varchar(255) PRIMARY KEY,
  "last_success_at" timestamptz,
  "last_failure_at" timestamptz,
  "last_error_class" varchar(16),
  "last_error_message" text,
  "failing_since" timestamptz,
  "consecutive_failures" integer NOT NULL DEFAULT 0,
  "last_warned_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
