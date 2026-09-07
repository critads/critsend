import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMPLAINT_IP,
  COMPLAINT_IPS,
  COMPLAINT_IP_SUPPRESSION_DAYS,
} from "../server/config/suppression";

const trackingRouteSource = readFileSync("server/routes/tracking.ts", "utf8");
const trackingBufferSource = readFileSync("server/tracking-buffer.ts", "utf8");
const segmentCompilerSource = readFileSync(
  "server/services/segment-compiler.ts",
  "utf8",
);
const subscriberRepositorySource = readFileSync(
  "server/repositories/subscriber-repository.ts",
  "utf8",
);
const pressureWorkerSource = readFileSync(
  "server/workers/pressure-guard-worker.ts",
  "utf8",
);
const automationEngineSource = readFileSync(
  "server/services/automation-engine.ts",
  "utf8",
);

const backfillSection = trackingRouteSource.slice(
  trackingRouteSource.indexOf(
    "// Apply the complaint-IP cooling-off rule retroactively",
  ),
  trackingRouteSource.indexOf(
    'indexExistsAndValid("campaign_stats_campaign_subscriber_type_idx")',
  ),
);

describe("complaint-IP temporary suppression wiring", () => {
  it("centralizes the exact IP and 15-day window", () => {
    expect(COMPLAINT_IP).toBe("195.154.17.225");
    expect(COMPLAINT_IPS.has(COMPLAINT_IP)).toBe(true);
    expect(COMPLAINT_IPS.size).toBe(1);
    expect(COMPLAINT_IP_SUPPRESSION_DAYS).toBe(15);
    expect(trackingRouteSource).toContain("COMPLAINT_IPS.has");
    expect(trackingBufferSource).toContain("COMPLAINT_IPS.has");
  });

  it("backfills from the latest matching event without restarting the window", () => {
    expect(backfillSection).toContain("MAX(timestamp) AS detected_at");
    expect(backfillSection).toContain("type IN ('open', 'complaint')");
    expect(backfillSection).toContain(
      "timestamp >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')",
    );
    expect(backfillSection).toContain(
      "SET suppressed_until = d.detected_at",
    );
    expect(backfillSection).toContain("s.suppressed_until IS NULL");
    expect(backfillSection).toContain(
      "s.suppressed_until < d.detected_at",
    );
    expect(backfillSection).toContain("RETURNING 1");
    expect(backfillSection).not.toContain("columnHasData");
    expect(trackingRouteSource).toContain(
      "campaign_stats_complaint_ip_timestamp_subscriber_idx",
    );
    expect(trackingRouteSource).toContain(
      "ON campaign_stats (timestamp, subscriber_id)",
    );
  });

  it("persists the event and suppression atomically using UTC event time", () => {
    const atomicWriteSection = trackingBufferSource.slice(
      trackingBufferSource.indexOf(
        "async function insertBatchAndBumpCounters",
      ),
      trackingBufferSource.indexOf(
        "async function applyComplaintIpSuppressionsOnClient",
      ),
    );
    const insertIndex = atomicWriteSection.indexOf(
      "await insertBatchOnClient(client, type, events)",
    );
    const suppressionIndex = atomicWriteSection.indexOf(
      "await applyComplaintIpSuppressionsOnClient(client, events)",
    );
    const commitIndex = atomicWriteSection.indexOf(
      'await client.query("COMMIT")',
      insertIndex,
    );
    expect(insertIndex).toBeGreaterThan(-1);
    expect(suppressionIndex).toBeGreaterThan(insertIndex);
    expect(commitIndex).toBeGreaterThan(suppressionIndex);
    expect(trackingBufferSource).toContain("ev.enqueuedAt > previous");
    expect(trackingBufferSource).toContain(
      "d.detected_at + make_interval(days => $3)",
    );
    expect(trackingBufferSource).toContain(
      "s.suppressed_until < d.detected_at + make_interval(days => $3)",
    );
    expect(trackingBufferSource).toContain("$2::timestamp[]");
    expect(trackingBufferSource).not.toContain("$2::timestamptz[]");
    expect(trackingBufferSource).toContain("$${p++}::timestamp");
    expect(trackingBufferSource).toContain(
      "const ts = formatUtcTimestamp(e.enqueuedAt)",
    );
  });

  it("serializes complaint uniqueness across PM2 instances", () => {
    const counterWriteSection = trackingBufferSource.slice(
      trackingBufferSource.indexOf(
        "async function insertBatchAndBumpCounters",
      ),
      trackingBufferSource.indexOf(
        "async function applyComplaintIpSuppressionsOnClient",
      ),
    );
    const lockIndex = counterWriteSection.indexOf(
      "pg_advisory_xact_lock(lock_hash)",
    );
    const existingPairIndex = counterWriteSection.indexOf(
      "SELECT campaign_id, subscriber_id",
    );
    expect(lockIndex).toBeGreaterThan(-1);
    expect(existingPairIndex).toBeGreaterThan(lockIndex);
    expect(counterWriteSection).toContain("hashtextextended(lock_key, 0)");
    expect(counterWriteSection).toContain("ORDER BY lock_hash");
  });

  it("uses Express proxy sanitization rather than raw forwarding headers", () => {
    const extractSection = trackingRouteSource.slice(
      trackingRouteSource.indexOf("function extractTrackingContext"),
      trackingRouteSource.indexOf("function isSafeRedirectUrl"),
    );
    expect(extractSection).toContain("req.ip");
    expect(extractSection).not.toContain('req.headers["x-forwarded-for"]');
    expect(extractSection).not.toContain('req.headers["x-real-ip"]');
  });

  it("retains shared audience and final-send suppression guards", () => {
    expect(segmentCompilerSource).toContain(
      "suppressed_until IS NULL OR suppressed_until < NOW()",
    );
    expect(
      subscriberRepositorySource.match(/suppressed_until IS NULL/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(5);
    expect(pressureWorkerSource).toContain(
      "row.suppressed_until && new Date(row.suppressed_until) > new Date()",
    );
    expect(automationEngineSource).toContain(
      "subscriber.suppressedUntil && new Date(subscriber.suppressedUntil) > new Date()",
    );
  });
});