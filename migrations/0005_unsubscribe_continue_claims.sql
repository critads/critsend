CREATE TABLE IF NOT EXISTS "unsubscribe_continue_claims" (
  "ip_hash" varchar(64) PRIMARY KEY NOT NULL,
  "claimed_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "unsubscribe_continue_claims_ip_hash_format_check"
    CHECK ("ip_hash" ~ '^[0-9a-f]{64}$')
);