import { describe, it, expect, afterEach } from "vitest";
import {
  classifySmtpFailure,
  zeroDupSendGuardEnabled,
} from "../server/config/send-guard";

describe("zeroDupSendGuardEnabled", () => {
  const original = process.env.ZERO_DUP_SEND_GUARD;
  afterEach(() => {
    if (original === undefined) delete process.env.ZERO_DUP_SEND_GUARD;
    else process.env.ZERO_DUP_SEND_GUARD = original;
  });

  it("defaults to OFF", () => {
    delete process.env.ZERO_DUP_SEND_GUARD;
    expect(zeroDupSendGuardEnabled()).toBe(false);
  });

  it("is OFF for any value other than the string 'true'", () => {
    for (const v of ["false", "1", "TRUE", "yes", "on", ""]) {
      process.env.ZERO_DUP_SEND_GUARD = v;
      expect(zeroDupSendGuardEnabled()).toBe(false);
    }
  });

  it("is ON only for the exact string 'true'", () => {
    process.env.ZERO_DUP_SEND_GUARD = "true";
    expect(zeroDupSendGuardEnabled()).toBe(true);
  });
});

describe("classifySmtpFailure", () => {
  it("treats nullish / unknown errors as ambiguous (safe default)", () => {
    expect(classifySmtpFailure(undefined)).toBe("ambiguous");
    expect(classifySmtpFailure(null)).toBe("ambiguous");
    expect(classifySmtpFailure(new Error("totally unexpected"))).toBe("ambiguous");
    expect(classifySmtpFailure({})).toBe("ambiguous");
  });

  it("classifies pre-data SMTP commands as retryable", () => {
    for (const command of ["CONN", "EHLO", "HELO", "STARTTLS", "AUTH", "MAIL", "MAIL FROM", "RCPT", "RCPT TO"]) {
      expect(classifySmtpFailure({ command })).toBe("pre_data_retryable");
    }
  });

  it("classifies lowercase command tags too (case-insensitive)", () => {
    expect(classifySmtpFailure({ command: "rcpt to" })).toBe("pre_data_retryable");
    expect(classifySmtpFailure({ command: "data" })).toBe("ambiguous");
  });

  it("classifies data / end-of-data commands as ambiguous", () => {
    for (const command of ["DATA", "BDAT", "."]) {
      expect(classifySmtpFailure({ command })).toBe("ambiguous");
    }
  });

  it("a post-DATA response code stays ambiguous (command wins over code)", () => {
    // 451 deferral AFTER the body was sent — the server may have queued it.
    expect(classifySmtpFailure({ command: ".", responseCode: 451 })).toBe("ambiguous");
    expect(classifySmtpFailure({ command: "DATA", responseCode: 554 })).toBe("ambiguous");
  });

  it("a bare 4xx/5xx response code (pre-acceptance rejection) is retryable", () => {
    expect(classifySmtpFailure({ responseCode: 421 })).toBe("pre_data_retryable");
    expect(classifySmtpFailure({ responseCode: 450 })).toBe("pre_data_retryable");
    expect(classifySmtpFailure({ responseCode: 550 })).toBe("pre_data_retryable");
    expect(classifySmtpFailure({ responseCode: 554 })).toBe("pre_data_retryable");
  });

  it("classifies connect/DNS/auth transport codes as retryable", () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EAUTH", "ECONNECTION"]) {
      expect(classifySmtpFailure({ code })).toBe("pre_data_retryable");
    }
  });

  it("classifies in-flight socket/timeout transport codes as ambiguous", () => {
    for (const code of ["ETIMEDOUT", "ECONNRESET", "EPIPE", "ESOCKET"]) {
      expect(classifySmtpFailure({ code })).toBe("ambiguous");
    }
  });

  it("a connect-stage timeout (command=CONN) is retryable despite ETIMEDOUT code", () => {
    // nodemailer tags a connection timeout with command='CONN'; the command
    // signal (pre-data) must win over the otherwise-ambiguous ETIMEDOUT code.
    expect(classifySmtpFailure({ command: "CONN", code: "ETIMEDOUT" })).toBe("pre_data_retryable");
  });

  it("our sendMailBounded timeout (ETIMEDOUT, no command) is ambiguous", () => {
    const err: any = new Error("SMTP sendMail timed out after 60000ms");
    err.code = "ETIMEDOUT";
    expect(classifySmtpFailure(err)).toBe("ambiguous");
  });
});
