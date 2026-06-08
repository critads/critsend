/**
 * Task #199: regression coverage for the bounded SMTP send that defuses the
 * campaign "hung-tick" wedge. A never-settling `transporter.sendMail` (pooled
 * transporter with no free connection) used to freeze the send loop forever;
 * `sendMailBounded` converts that hang into a retryable `ETIMEDOUT` so the
 * loop keeps heartbeating and the worker watchdog never has to fire.
 */
import { describe, it, expect, vi } from "vitest";
import { sendMailBounded } from "../server/email-service";

describe("sendMailBounded (Task #199)", () => {
  it("resolves with the sendMail result when it settles before the timeout", async () => {
    const transporter = {
      sendMail: vi.fn().mockResolvedValue({ messageId: "ok-123" }),
    };
    const info = await sendMailBounded(transporter as any, { to: "a@b.com" } as any);
    expect(info).toEqual({ messageId: "ok-123" });
    expect(transporter.sendMail).toHaveBeenCalledOnce();
  });

  it("propagates a genuine sendMail rejection unchanged", async () => {
    const realErr: any = new Error("550 rejected");
    realErr.responseCode = 550;
    const transporter = { sendMail: vi.fn().mockRejectedValue(realErr) };
    await expect(sendMailBounded(transporter as any, {} as any)).rejects.toThrow("550 rejected");
  });

  it("rejects with a retryable ETIMEDOUT when sendMail never settles", async () => {
    vi.useFakeTimers();
    try {
      // A send that never resolves — the exact failure mode of a pooled
      // transporter waiting forever for a free connection.
      const transporter = { sendMail: vi.fn(() => new Promise(() => {})) };
      const p = sendMailBounded(transporter as any, {} as any);
      const assertion = expect(p).rejects.toMatchObject({ code: "ETIMEDOUT" });
      // Advance past the default 60s bound (env-overridable).
      await vi.advanceTimersByTimeAsync(60_000 + 1_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
