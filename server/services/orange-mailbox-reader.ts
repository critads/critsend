// Orange Test — read-only IMAP lookup of the Orange test mailbox.
//
// One session checks any number of pending tests: connect, find the Inbox and
// the junk folder, and look for each test's own reference (Message-ID first,
// then a text search of the reference, then a fallback on subject / sender /
// send time with the reference read from the body). The reader never picks
// "the newest message": two tests sent on different days can never be mixed
// up. Mailboxes are opened read-only (EXAMINE) and bodies are fetched with
// PEEK, so nothing is ever marked read or deleted. Credentials are never
// logged: the imapflow logger is disabled and error texts are scrubbed.
import { ImapFlow } from "imapflow";
import { ORANGE_SPAM_LEVEL_HEADER, ORANGE_TEST_REFERENCE_PREFIX } from "@shared/orange-test";
import type { OrangeTestConfig } from "../config/orange-test";
import { PLAIN_TEST_SUBJECT } from "./plain-test-sender";

export interface MailboxLookupRequest {
  reference: string;
  /** Message-ID as stamped on the outgoing email (angle brackets included). */
  messageId: string;
  fromEmail: string;
  sentAt: Date;
}

export type MailboxFolderKind = "inbox" | "junk";
export type MailboxMatchKind = "message-id" | "text" | "fallback";

export interface MailboxLookupHit {
  reference: string;
  folder: MailboxFolderKind;
  folderPath: string;
  matchedBy: MailboxMatchKind;
  messageId: string | null;
  spamLevelRaw: string | null;
  /** Diagnostic headers kept verbatim (X-me-*, Authentication-Results, …). */
  headers: Record<string, string>;
  receivedAt: Date | null;
}

export interface MailboxLookupResult {
  hits: Map<string, MailboxLookupHit>;
  foldersSearched: string[];
  /** Non-fatal problems met during the session (a search the server refused, …). */
  warnings: string[];
}

export type OrangeMailboxErrorCode = "AUTH" | "NETWORK" | "TIMEOUT" | "IMAP";

export class OrangeMailboxError extends Error {
  constructor(public readonly code: OrangeMailboxErrorCode, message: string) {
    super(message);
    this.name = "OrangeMailboxError";
  }
}

/** Subset of the imapflow client the reader relies on (fakeable in tests). */
export interface ImapFolderInfo {
  path: string;
  name: string;
  specialUse?: string;
}

export interface ImapFetchedMessage {
  uid: number;
  source?: Buffer;
  internalDate?: Date | string;
  envelope?: { messageId?: string };
}

export interface ImapClientLike {
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
  list(): Promise<ImapFolderInfo[]>;
  getMailboxLock(path: string, options: { readOnly: boolean }): Promise<{ release(): void }>;
  search(query: Record<string, unknown>, options: { uid: boolean }): Promise<number[] | false | undefined>;
  fetchOne(
    uid: number,
    query: Record<string, unknown>,
    options: { uid: boolean },
  ): Promise<ImapFetchedMessage | false | undefined>;
}

export type ImapClientFactory = (config: OrangeTestConfig) => ImapClientLike;

export const defaultImapClientFactory: ImapClientFactory = (config) =>
  new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapSecure,
    auth: { user: config.imapUser, pass: config.imapPassword },
    // No logger at all: imapflow's default logger would write the LOGIN
    // command (credentials included when logRaw is on) — keep it silent.
    logger: false,
    emitLogs: false,
    disableAutoIdle: true,
    connectionTimeout: config.imapTimeoutMs,
    greetingTimeout: config.imapTimeoutMs,
    socketTimeout: config.imapTimeoutMs,
    clientInfo: { name: "critsend-orange-test", vendor: "critsend" },
  }) as unknown as ImapClientLike;

const JUNK_FOLDER_NAME = /^(junk( e-?mail)?|spam|bulk( mail)?|ind[ée]sirables?|courriers? ind[ée]sirables?|pourriels?)$/i;
const FALLBACK_CANDIDATE_LIMIT = 40;
const SOURCE_MAX_BYTES = 64 * 1024;
const KEPT_HEADERS = new Set([
  "authentication-results",
  "received-spf",
  "return-path",
  "message-id",
  "date",
  "subject",
  "from",
  "to",
  "x-original-to",
  "delivered-to",
]);
const HEADER_VALUE_MAX = 2000;

/** Whole header block → lowercase name → value (repeated headers joined by newline). */
export function parseHeaderBlock(block: string): Map<string, string> {
  const unfolded = block.replace(/\r?\n[ \t]+/g, " ");
  const headers = new Map<string, string>();
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    if (!/^[!-9;-~]+$/.test(name)) continue; // not a header token
    const value = line.slice(idx + 1).trim();
    const previous = headers.get(name);
    headers.set(name, previous === undefined ? value : `${previous}\n${value}`);
  }
  return headers;
}

export interface ParsedSource {
  headers: Map<string, string>;
  body: string;
}

export function parseMessageSource(source: Buffer | string): ParsedSource {
  const text = typeof source === "string" ? source : source.toString("utf8");
  const match = /\r?\n\r?\n/.exec(text);
  const headerBlock = match ? text.slice(0, match.index) : text;
  const body = match ? text.slice(match.index + match[0].length) : "";
  return { headers: parseHeaderBlock(headerBlock), body };
}

/** Diagnostic subset of the headers, values bounded. */
export function pickDiagnosticHeaders(headers: Map<string, string>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (name.startsWith("x-me-") || KEPT_HEADERS.has(name)) {
      kept[name] = value.length > HEADER_VALUE_MAX ? `${value.slice(0, HEADER_VALUE_MAX)}…` : value;
    }
  }
  return kept;
}

const REFERENCE_IN_BODY = new RegExp(`Ref:\\s*(${ORANGE_TEST_REFERENCE_PREFIX}[A-Za-z0-9-]+)`, "i");

export function extractReferenceFromBody(body: string): string | null {
  const match = REFERENCE_IN_BODY.exec(body);
  return match ? match[1].toUpperCase() : null;
}

export function classifyJunkFolder(folders: ImapFolderInfo[]): ImapFolderInfo | null {
  const bySpecialUse = folders.find((f) => (f.specialUse || "").toLowerCase() === "\\junk");
  if (bySpecialUse) return bySpecialUse;
  const byName = folders.find((f) => {
    const leaf = f.name || f.path.split(/[./]/).pop() || "";
    return JUNK_FOLDER_NAME.test(leaf.trim());
  });
  return byName ?? null;
}

function scrub(message: string, config: OrangeTestConfig): string {
  let out = message;
  if (config.imapPassword && config.imapPassword.length >= 4) {
    out = out.split(config.imapPassword).join("***");
  }
  return out;
}

function classifyImapError(error: any, config: OrangeTestConfig): OrangeMailboxError {
  if (error instanceof OrangeMailboxError) return error;
  const message = scrub(String(error?.responseText || error?.message || error || "IMAP error"), config);
  if (error?.authenticationFailed || /authenticat|login failed|invalid credentials/i.test(message)) {
    return new OrangeMailboxError(
      "AUTH",
      `IMAP authentication refused by ${config.imapHost} (${message}). Check ORANGE_TEST_IMAP_PASSWORD and, in the Orange webmail, that IMAP access is allowed for this mailbox and this server location.`,
    );
  }
  const code = String(error?.code || "").toUpperCase();
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || /timed? ?out/i.test(message)) {
    return new OrangeMailboxError("TIMEOUT", `IMAP timeout talking to ${config.imapHost}:${config.imapPort} (${message}).`);
  }
  if (code.startsWith("E") || /getaddrinfo|ECONN|socket|network|certificate|tls/i.test(message)) {
    return new OrangeMailboxError("NETWORK", `Cannot reach ${config.imapHost}:${config.imapPort} (${message}).`);
  }
  return new OrangeMailboxError("IMAP", message);
}

async function withDeadline<T>(promise: Promise<T>, ms: number, onTimeout: () => void, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout(); } catch { /* best effort */ }
      reject(new OrangeMailboxError("TIMEOUT", `${label} exceeded ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toDate(value: Date | string | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function uidList(result: number[] | false | undefined): number[] {
  return Array.isArray(result) ? result.filter((n) => Number.isFinite(n)) : [];
}

interface FolderTarget {
  kind: MailboxFolderKind;
  info: ImapFolderInfo;
}

async function fetchParsed(client: ImapClientLike, uid: number): Promise<{ message: ImapFetchedMessage; parsed: ParsedSource } | null> {
  const message = await client.fetchOne(
    uid,
    { source: { maxLength: SOURCE_MAX_BYTES }, internalDate: true, envelope: true },
    { uid: true },
  );
  if (!message || !message.source) return null;
  return { message, parsed: parseMessageSource(message.source) };
}

function buildHit(
  request: MailboxLookupRequest,
  target: FolderTarget,
  matchedBy: MailboxMatchKind,
  message: ImapFetchedMessage,
  parsed: ParsedSource,
): MailboxLookupHit {
  const spamLevel = parsed.headers.get(ORANGE_SPAM_LEVEL_HEADER);
  return {
    reference: request.reference,
    folder: target.kind,
    folderPath: target.info.path,
    matchedBy,
    messageId: parsed.headers.get("message-id") ?? message.envelope?.messageId ?? null,
    spamLevelRaw: spamLevel === undefined ? null : spamLevel,
    headers: pickDiagnosticHeaders(parsed.headers),
    receivedAt: toDate(message.internalDate),
  };
}

async function searchFolder(
  client: ImapClientLike,
  target: FolderTarget,
  pending: Map<string, MailboxLookupRequest>,
  result: MailboxLookupResult,
): Promise<void> {
  const lock = await client.getMailboxLock(target.info.path, { readOnly: true });
  try {
    result.foldersSearched.push(target.info.path);
    // 1 + 2: per test, Message-ID header then reference text search.
    for (const request of [...pending.values()]) {
      let matchedBy: MailboxMatchKind | null = null;
      let uids: number[] = [];
      try {
        uids = uidList(await client.search({ header: { "message-id": request.messageId } }, { uid: true }));
        if (uids.length > 0) matchedBy = "message-id";
      } catch (error: any) {
        result.warnings.push(`${target.info.path}: Message-ID search failed (${error?.message || error})`);
      }
      if (!matchedBy) {
        try {
          uids = uidList(await client.search({ text: request.reference }, { uid: true }));
          if (uids.length > 0) matchedBy = "text";
        } catch (error: any) {
          result.warnings.push(`${target.info.path}: text search failed (${error?.message || error})`);
        }
      }
      if (!matchedBy) continue;
      // Newest UID first; confirm the reference is really this message.
      for (const uid of [...uids].sort((a, b) => b - a).slice(0, 5)) {
        const fetched = await fetchParsed(client, uid);
        if (!fetched) continue;
        const idHeader = (fetched.parsed.headers.get("message-id") || "").trim();
        const bodyRef = extractReferenceFromBody(fetched.parsed.body);
        const idMatches = idHeader !== "" && idHeader.toLowerCase() === request.messageId.toLowerCase();
        const refMatches = bodyRef === request.reference.toUpperCase()
          || idHeader.toUpperCase().includes(request.reference.toUpperCase());
        if (!idMatches && !refMatches) continue;
        result.hits.set(request.reference, buildHit(request, target, matchedBy, fetched.message, fetched.parsed));
        pending.delete(request.reference);
        break;
      }
    }
    if (pending.size === 0) return;

    // 3: fallback — "Hello moon" from the MTA's sender since the earliest
    // send, reference read from the body. One search per distinct sender.
    const senders = new Map<string, MailboxLookupRequest[]>();
    for (const request of pending.values()) {
      const key = request.fromEmail.trim().toLowerCase();
      senders.set(key, [...(senders.get(key) || []), request]);
    }
    for (const [sender, requests] of senders) {
      const earliest = requests.reduce((min, r) => (r.sentAt < min ? r.sentAt : min), requests[0].sentAt);
      // IMAP SINCE has day granularity; start the day before to absorb timezone skew.
      const since = new Date(earliest.getTime() - 24 * 60 * 60 * 1000);
      let uids: number[] = [];
      try {
        uids = uidList(await client.search({ from: sender, subject: PLAIN_TEST_SUBJECT, since }, { uid: true }));
      } catch (error: any) {
        result.warnings.push(`${target.info.path}: fallback search failed (${error?.message || error})`);
        continue;
      }
      const wanted = new Map(requests.map((r) => [r.reference.toUpperCase(), r] as const));
      for (const uid of [...uids].sort((a, b) => b - a).slice(0, FALLBACK_CANDIDATE_LIMIT)) {
        if (wanted.size === 0) break;
        const fetched = await fetchParsed(client, uid);
        if (!fetched) continue;
        const bodyRef = extractReferenceFromBody(fetched.parsed.body);
        const request = bodyRef ? wanted.get(bodyRef) : undefined;
        if (!request || !pending.has(request.reference)) continue;
        result.hits.set(request.reference, buildHit(request, target, "fallback", fetched.message, fetched.parsed));
        pending.delete(request.reference);
        wanted.delete(bodyRef!);
      }
    }
  } finally {
    lock.release();
  }
}

async function runSession(
  requests: MailboxLookupRequest[],
  config: OrangeTestConfig,
  client: ImapClientLike,
): Promise<MailboxLookupResult> {
  const result: MailboxLookupResult = { hits: new Map(), foldersSearched: [], warnings: [] };
  const pending = new Map(requests.map((r) => [r.reference, r] as const));
  if (pending.size === 0) return result;

  await client.connect();
  try {
    const folders = await client.list();
    const inbox = folders.find((f) => f.path.toUpperCase() === "INBOX") ?? { path: "INBOX", name: "INBOX" };
    const junk = classifyJunkFolder(folders.filter((f) => f.path.toUpperCase() !== "INBOX"));
    const targets: FolderTarget[] = [{ kind: "inbox", info: inbox }];
    if (junk) targets.push({ kind: "junk", info: junk });
    else result.warnings.push("No junk folder found in the mailbox (only the Inbox was searched).");

    for (const target of targets) {
      if (pending.size === 0) break;
      await searchFolder(client, target, pending, result);
    }
  } finally {
    try {
      await withDeadline(client.logout(), 5_000, () => client.close(), "IMAP logout");
    } catch {
      client.close();
    }
  }
  return result;
}

// One mailbox session at a time in this process. The chain never waits on a
// hung session: every session runs under a hard deadline that destroys the
// socket, so the next caller is released even when the server stops answering.
let sessionChain: Promise<unknown> = Promise.resolve();

/**
 * Looks every pending test up in the Orange mailbox within ONE IMAP session.
 * Resolves with the hits found (keyed by reference); tests that are absent
 * from the mailbox are simply missing from `hits`. Rejects with an
 * OrangeMailboxError when the session itself failed (auth, network, timeout).
 */
export function lookupOrangeTests(
  requests: MailboxLookupRequest[],
  config: OrangeTestConfig,
  createClient: ImapClientFactory = defaultImapClientFactory,
): Promise<MailboxLookupResult> {
  const run = sessionChain.then(async () => {
    if (!config.enabled) throw new OrangeMailboxError("AUTH", "Orange Test mailbox is not configured (no IMAP password).");
    const client = createClient(config);
    try {
      return await withDeadline(
        runSession(requests, config, client),
        config.sessionTimeoutMs,
        () => client.close(),
        "Orange mailbox session",
      );
    } catch (error) {
      throw classifyImapError(error, config);
    }
  });
  sessionChain = run.catch(() => undefined);
  return run;
}
