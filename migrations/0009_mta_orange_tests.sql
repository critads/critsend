-- Orange Test: automated deliverability tests per MTA (raw Plain Test sent to
-- the Orange mailbox, mailbox polled over IMAP, X-me-spamlevel → verdict).
-- Mirrors the pgTable declaration in shared/schema.ts so both drizzle-kit push
-- and hand-applied migrations converge on the same shape; also created
-- idempotently at startup by server/orange-test-bootstrap.ts.
CREATE TABLE IF NOT EXISTS "mta_orange_tests" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "mta_id" varchar NOT NULL REFERENCES "mtas"("id") ON DELETE CASCADE,
  "reference" varchar(64) NOT NULL,
  "message_id" varchar(255) NOT NULL,
  "status" varchar(16) NOT NULL DEFAULT 'sending',
  "verdict" varchar(16),
  "spam_level_raw" text,
  "found_in" varchar(16),
  "found_folder" text,
  "matched_by" varchar(16),
  "raw_headers" jsonb,
  "mailbox" varchar(255) NOT NULL,
  "from_email" text NOT NULL,
  "requested_by" varchar(255),
  "send_error" jsonb,
  "send_note" text,
  "last_check_error" text,
  "last_check_at" timestamptz,
  "poll_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "sent_at" timestamptz,
  "next_poll_at" timestamptz,
  "deadline_at" timestamptz,
  "received_at" timestamptz,
  "finished_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "mta_orange_tests_reference_idx"
  ON "mta_orange_tests" ("reference");

CREATE INDEX IF NOT EXISTS "mta_orange_tests_mta_created_idx"
  ON "mta_orange_tests" ("mta_id", "created_at" DESC);

-- One pending test per MTA.
CREATE UNIQUE INDEX IF NOT EXISTS "mta_orange_tests_pending_mta_idx"
  ON "mta_orange_tests" ("mta_id") WHERE status IN ('sending', 'waiting');

CREATE INDEX IF NOT EXISTS "mta_orange_tests_due_idx"
  ON "mta_orange_tests" ("next_poll_at") WHERE status IN ('sending', 'waiting');
