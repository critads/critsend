import { describe, expect, it, vi } from "vitest";

vi.mock("../server/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import {
  classifyJunkFolder,
  extractReferenceFromBody,
  lookupOrangeTests,
  OrangeMailboxError,
  parseMessageSource,
  type ImapClientLike,
  type ImapFetchedMessage,
  type ImapFolderInfo,
  type MailboxLookupRequest,
} from "../server/services/orange-mailbox-reader";
import type { OrangeTestConfig } from "../server/config/orange-test";

function makeConfig(overrides: Partial<OrangeTestConfig> = {}): OrangeTestConfig {
  return {
    mailbox: "ianisbaulle@orange.fr",
    imapHost: "imap.orange.fr",
    imapPort: 993,
    imapSecure: true,
    imapUser: "ianisbaulle@orange.fr",
    imapPassword: "hunter22",
    enabled: true,
    maxWaitMs: 48 * 3600_000,
    maxWaitHours: 48,
    fastPollMs: 30_000,
    fastPhaseMs: 300_000,
    slowPollMs: 300_000,
    fastPollSeconds: 30,
    fastPhaseMinutes: 5,
    slowPollMinutes: 5,
    imapTimeoutMs: 1_000,
    sessionTimeoutMs: 2_000,
    checkerIntervalMs: 15_000,
    checkerBatchSize: 50,
    staleSendingMs: 600_000,
    staleVerdictDays: 7,
    ...overrides,
  };
}

interface FakeMessage {
  uid: number;
  folder: string;
  source: string;
  internalDate: Date;
}

function rfc822(headers: Record<string, string>, body: string): string {
  return `${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n${body}`;
}

/** Minimal IMAP behaviour: header/text/from+subject searches over an in-memory folder set. */
function fakeClient(folders: ImapFolderInfo[], messages: FakeMessage[], hooks: {
  onConnect?: () => Promise<void>;
  onSearch?: (query: Record<string, unknown>) => void;
} = {}) {
  let selected: string | null = null;
  const calls: string[] = [];
  const client: ImapClientLike & { calls: string[]; closed: boolean; loggedOut: boolean } = {
    calls,
    closed: false,
    loggedOut: false,
    async connect() { calls.push("connect"); if (hooks.onConnect) await hooks.onConnect(); },
    async logout() { calls.push("logout"); client.loggedOut = true; },
    close() { client.closed = true; },
    async list() { return folders; },
    async getMailboxLock(path, options) {
      expect(options.readOnly).toBe(true);
      selected = path;
      calls.push(`select ${path}`);
      return { release() { selected = null; } };
    },
    async search(query) {
      hooks.onSearch?.(query);
      calls.push(`search ${JSON.stringify(query)}`);
      const inFolder = messages.filter((m) => m.folder === selected);
      if (query.header && typeof query.header === "object") {
        const wanted = String((query.header as Record<string, string>)["message-id"]).toLowerCase();
        return inFolder.filter((m) => /^message-id:\s*(.+)$/im.exec(m.source)?.[1].trim().toLowerCase() === wanted).map((m) => m.uid);
      }
      if (typeof query.text === "string") {
        const needle = query.text.toLowerCase();
        return inFolder.filter((m) => m.source.toLowerCase().includes(needle)).map((m) => m.uid);
      }
      if (typeof query.from === "string") {
        return inFolder
          .filter((m) => m.source.toLowerCase().includes(`from: ${String(query.from).toLowerCase()}`))
          .filter((m) => m.source.includes(`Subject: ${query.subject}`))
          .filter((m) => m.internalDate >= (query.since as Date))
          .map((m) => m.uid);
      }
      return [];
    },
    async fetchOne(uid): Promise<ImapFetchedMessage | false> {
      const m = messages.find((x) => x.uid === uid && x.folder === selected);
      if (!m) return false;
      return { uid, source: Buffer.from(m.source), internalDate: m.internalDate };
    },
  };
  return client;
}

const FOLDERS: ImapFolderInfo[] = [
  { path: "INBOX", name: "INBOX" },
  { path: "Drafts", name: "Drafts", specialUse: "\\Drafts" },
  { path: "Junk", name: "Junk", specialUse: "\\Junk" },
];

function request(reference: string, sentAt = new Date("2026-09-28T10:00:00Z")): MailboxLookupRequest {
  return { reference, messageId: `<${reference}@mail.example.com>`, fromEmail: "news@mail.example.com", sentAt };
}

describe("orange mailbox reader — parsing", () => {
  it("parses headers case-insensitively, unfolds continuation lines and keeps the body", () => {
    const parsed = parseMessageSource(rfc822(
      { "X-ME-SpamLevel": "not-spam", "Authentication-Results": "orange.fr;\r\n dkim=pass", "Message-ID": "<OT-1@x>" },
      "I'm the sun\r\nRef: OT-20260928-ABCDEF01\r\n",
    ));
    expect(parsed.headers.get("x-me-spamlevel")).toBe("not-spam");
    expect(parsed.headers.get("authentication-results")).toBe("orange.fr; dkim=pass");
    expect(extractReferenceFromBody(parsed.body)).toBe("OT-20260928-ABCDEF01");
  });

  it("finds the junk folder by special-use flag, then by localized name", () => {
    expect(classifyJunkFolder(FOLDERS)?.path).toBe("Junk");
    expect(classifyJunkFolder([{ path: "INBOX/Courriers indésirables", name: "Courriers indésirables" }])?.path)
      .toBe("INBOX/Courriers indésirables");
    expect(classifyJunkFolder([{ path: "Archive", name: "Archive" }])).toBeNull();
  });
});

describe("orange mailbox reader — lookup", () => {
  it("finds a test by Message-ID in the Inbox and reads X-me-spamlevel", async () => {
    const ref = "OT-20260928-11111111";
    const client = fakeClient(FOLDERS, [
      {
        uid: 7, folder: "INBOX", internalDate: new Date("2026-09-28T10:02:00Z"),
        source: rfc822({ "From": "news@mail.example.com", "Subject": "Hello moon", "Message-ID": `<${ref}@mail.example.com>`, "X-me-spamlevel": "not-spam" }, `I'm the sun\r\nRef: ${ref}`),
      },
    ]);
    const result = await lookupOrangeTests([request(ref)], makeConfig(), () => client);
    const hit = result.hits.get(ref);
    expect(hit).toBeDefined();
    expect(hit!.folder).toBe("inbox");
    expect(hit!.matchedBy).toBe("message-id");
    expect(hit!.spamLevelRaw).toBe("not-spam");
    expect(hit!.receivedAt?.toISOString()).toBe("2026-09-28T10:02:00.000Z");
    expect(hit!.headers["message-id"]).toBe(`<${ref}@mail.example.com>`);
    // Found in the Inbox → the Junk folder is not even opened.
    expect(client.calls.filter((c) => c.startsWith("select"))).toEqual(["select INBOX"]);
    expect(client.loggedOut).toBe(true);
  });

  it("falls back to the text search, then to subject/from/date with the body reference — Junk included", async () => {
    const refText = "OT-20260928-22222222";
    const refBody = "OT-20260928-33333333";
    const client = fakeClient(FOLDERS, [
      {
        // Orange rewrote the Message-ID; only the body still carries the reference (text search hits it).
        uid: 3, folder: "Junk", internalDate: new Date("2026-09-28T11:00:00Z"),
        source: rfc822({ "From": "news@mail.example.com", "Subject": "Hello moon", "Message-ID": "<rewritten-1@orange.fr>", "X-me-spamlevel": "low" }, `I'm the sun\r\nRef: ${refText}`),
      },
      {
        // Neither header nor text search finds this one (fake TEXT search is broken on purpose below).
        uid: 4, folder: "Junk", internalDate: new Date("2026-09-28T11:05:00Z"),
        source: rfc822({ "From": "news@mail.example.com", "Subject": "Hello moon", "Message-ID": "<rewritten-2@orange.fr>", "X-me-spamlevel": "med" }, `I'm the sun\r\nRef: ${refBody}`),
      },
    ], {
      onSearch: (query) => {
        if (typeof query.text === "string" && query.text === refBody) throw new Error("BAD Command Argument Error");
      },
    });
    const result = await lookupOrangeTests([request(refText), request(refBody)], makeConfig(), () => client);
    expect(result.hits.get(refText)).toMatchObject({ folder: "junk", matchedBy: "text", spamLevelRaw: "low" });
    expect(result.hits.get(refBody)).toMatchObject({ folder: "junk", matchedBy: "fallback", spamLevelRaw: "med" });
    expect(result.foldersSearched).toEqual(["INBOX", "Junk"]);
    expect(result.warnings.some((w) => /text search failed/.test(w))).toBe(true);
    // Both were found in the end: a refused intermediate search leaves no test incomplete.
    expect(result.incomplete.size).toBe(0);
  });

  it("marks a test incomplete (not a clean miss) when a search that could have found it was refused", async () => {
    const refused = "OT-20260928-55555555";
    const clean = "OT-20260928-66666666";
    const client = fakeClient(FOLDERS, [], {
      onSearch: (query) => {
        // The server rejects every search that concerns `refused` (header, text and the sender fallback);
        // searches for `clean` run fine and legitimately find nothing.
        const header = query.header && typeof query.header === "object" ? String((query.header as Record<string, string>)["message-id"]) : "";
        if (header.includes(refused) || query.text === refused) throw new Error("BAD Command Argument Error");
        if (typeof query.from === "string" && query.from === "spam@other.example.com") throw new Error("NO search too complex");
      },
    });
    const requests = [request(refused), request(clean)];
    requests[0].fromEmail = "spam@other.example.com";
    const result = await lookupOrangeTests(requests, makeConfig(), () => client);
    expect(result.hits.size).toBe(0);
    expect(result.incomplete.has(refused)).toBe(true);
    expect(result.incomplete.get(refused)).toMatch(/INBOX: Message-ID search failed/);
    expect(result.incomplete.has(clean)).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("scrubs the password out of incomplete-lookup reasons", async () => {
    const ref = "OT-20260928-77777777";
    const client = fakeClient(FOLDERS, [], {
      onSearch: () => { throw new Error("BAD hunter22 is not a valid search key"); },
    });
    const result = await lookupOrangeTests([request(ref)], makeConfig(), () => client);
    expect(result.incomplete.get(ref)).toBeDefined();
    expect(result.incomplete.get(ref)).not.toContain("hunter22");
    expect(result.warnings.join(" ")).not.toContain("hunter22");
  });

  it("never attributes another test's message to a reference (different day, same sender)", async () => {
    const yesterday = "OT-20260927-AAAAAAAA";
    const today = "OT-20260928-BBBBBBBB";
    const client = fakeClient(FOLDERS, [
      {
        uid: 10, folder: "INBOX", internalDate: new Date("2026-09-28T09:00:00Z"),
        source: rfc822({ "From": "news@mail.example.com", "Subject": "Hello moon", "Message-ID": "<rewritten@orange.fr>", "X-me-spamlevel": "not-spam" }, `I'm the sun\r\nRef: ${yesterday}`),
      },
    ]);
    const result = await lookupOrangeTests([request(today, new Date("2026-09-28T10:00:00Z"))], makeConfig(), () => client);
    expect(result.hits.size).toBe(0);
  });

  it("reports a missing X-me-spamlevel header as null (verdict UNKNOWN upstream)", async () => {
    const ref = "OT-20260928-44444444";
    const client = fakeClient(FOLDERS, [
      {
        uid: 1, folder: "INBOX", internalDate: new Date(),
        source: rfc822({ "From": "news@mail.example.com", "Subject": "Hello moon", "Message-ID": `<${ref}@mail.example.com>` }, `I'm the sun\r\nRef: ${ref}`),
      },
    ]);
    const result = await lookupOrangeTests([request(ref)], makeConfig(), () => client);
    expect(result.hits.get(ref)?.spamLevelRaw).toBeNull();
  });

  it("classifies authentication failures and scrubs the password out of the message", async () => {
    const client = fakeClient(FOLDERS, [], {
      onConnect: async () => {
        const err: any = new Error("Command failed: LOGIN user hunter22 → NO AUTHENTICATIONFAILED");
        err.authenticationFailed = true;
        throw err;
      },
    });
    const config = makeConfig();
    await expect(lookupOrangeTests([request("OT-20260928-55555555")], config, () => client)).rejects.toMatchObject({
      name: "OrangeMailboxError",
      code: "AUTH",
    });
    try {
      await lookupOrangeTests([request("OT-20260928-55555555")], config, () => client);
    } catch (error) {
      expect(error).toBeInstanceOf(OrangeMailboxError);
      expect((error as Error).message).not.toContain("hunter22");
      expect((error as Error).message).toMatch(/Protocoles POP ou IMAP/);
    }
  });

  it("refuses to run when the mailbox is not configured", async () => {
    const client = fakeClient(FOLDERS, []);
    await expect(lookupOrangeTests([request("OT-20260928-66666666")], makeConfig({ enabled: false, imapPassword: "" }), () => client))
      .rejects.toMatchObject({ code: "AUTH" });
    expect(client.calls).toEqual([]);
  });

  it("closes a hung session at the deadline and releases the next caller", async () => {
    const hung = fakeClient(FOLDERS, [], { onConnect: () => new Promise<void>(() => { /* never settles */ }) });
    const config = makeConfig({ sessionTimeoutMs: 100 });
    await expect(lookupOrangeTests([request("OT-20260928-77777777")], config, () => hung)).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(hung.closed).toBe(true);
    const healthy = fakeClient(FOLDERS, []);
    const result = await lookupOrangeTests([request("OT-20260928-88888888")], config, () => healthy);
    expect(result.hits.size).toBe(0);
    expect(healthy.loggedOut).toBe(true);
  });
});
