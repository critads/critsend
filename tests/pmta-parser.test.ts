import { describe, it, expect } from "vitest";
import { parsePmtaQueueOutput } from "../server/services/pmta-collector";

describe("parsePmtaQueueOutput", () => {
  it("extracts pending count from 'Total messages' summary", () => {
    const raw = [
      "Queue for rndaserver.com:",
      "Total messages: 1234",
      "Active: 12",
      "",
    ].join("\n");
    const r = parsePmtaQueueOutput(raw);
    expect(r.pendingCount).toBe(1234);
    expect(r.parseStatus).toBe("ok");
    expect(r.errorCount).toBe(0);
  });

  it("extracts pending count from kmsg line", () => {
    const raw = "domain=foo kmsg 42 qmsg 7";
    const r = parsePmtaQueueOutput(raw);
    expect(r.pendingCount).toBe(42);
    expect(r.parseStatus).toBe("ok");
  });

  it("falls back to '<N> messages' wording", () => {
    const raw = "  17 messages queued for delivery";
    const r = parsePmtaQueueOutput(raw);
    expect(r.pendingCount).toBe(17);
    expect(r.parseStatus).toBe("ok");
  });

  it("matches the configured error pattern keywords", () => {
    const raw = [
      "Total messages: 5",
      "user@x.com 421 connection refused",
      "user@y.com 550 mailbox blocked",
      "user@z.com 250 ok delivered",
      "user@a.com defer-timeout retry later",
    ].join("\n");
    const r = parsePmtaQueueOutput(raw);
    expect(r.pendingCount).toBe(5);
    // 3 lines match (421/refused, 550/blocked, defer/timeout)
    expect(r.errorCount).toBeGreaterThanOrEqual(3);
    expect(r.errorLines.some((l) => /421/.test(l))).toBe(true);
    expect(r.errorLines.some((l) => /550/.test(l))).toBe(true);
    expect(r.errorLines.some((l) => /defer|timeout/i.test(l))).toBe(true);
  });

  it("matches every required SMTP code keyword", () => {
    for (const kw of ["error", "timeout", "refused", "blocked", "defer", "421", "450", "451", "452", "550", "554"]) {
      const r = parsePmtaQueueOutput(`Total messages: 1\nfoo@bar ${kw} happened`);
      expect(r.errorCount, `expected match for ${kw}`).toBeGreaterThanOrEqual(1);
    }
  });

  it("returns parse_error when no summary and no recipient rows are present", () => {
    const r = parsePmtaQueueOutput("garbage output that means nothing\n");
    expect(r.parseStatus).toBe("parse_error");
    expect(r.parseError).toBeTruthy();
    expect(r.pendingCount).toBe(0);
  });

  it("caps error lines at 50", () => {
    const lines: string[] = ["Total messages: 100"];
    for (let i = 0; i < 200; i++) lines.push(`user${i}@x.com 550 blocked`);
    const r = parsePmtaQueueOutput(lines.join("\n"));
    expect(r.errorLines.length).toBe(50);
  });

  it("counts recipient rows when summary is missing", () => {
    const raw = [
      "2026-05-28 12:00:00 user1@x.com queued",
      "2026-05-28 12:00:01 user2@x.com queued",
      "2026-05-28 12:00:02 user3@x.com queued",
    ].join("\n");
    const r = parsePmtaQueueOutput(raw);
    expect(r.pendingCount).toBe(3);
    expect(r.parseStatus).toBe("ok");
  });
});
