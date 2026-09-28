// Orange launch check in the campaign wizard: the pre-launch decision and its
// presentation (pure helpers, unit-tested; the component in
// components/campaign-wizard/orange-launch-check.tsx only renders them).
import {
  assessOrangeControlValue,
  type OrangeLaunchCheck,
  type OrangeTestControlValue,
  type OrangeTestVerdict,
} from "@shared/orange-test";

// ---------------------------------------------------------------------------
// Pre-launch decision
// ---------------------------------------------------------------------------

/** Longest the launch waits for a fresh control value before using what it has. */
export const ORANGE_LAUNCH_REFRESH_TIMEOUT_MS = 5_000;

export interface ResolveOrangeLaunchCheckOptions {
  mtaId: string;
  /** Fetches the MTA's control value now (aborted after `timeoutMs`). */
  fetchValue: (mtaId: string, signal: AbortSignal) => Promise<OrangeTestControlValue | undefined>;
  /** Check derived from the last summary the wizard displayed, if any. */
  cached: OrangeLaunchCheck | null;
  staleAfterDays: number;
  nowMs?: () => number;
  timeoutMs?: number;
}

export interface ResolvedOrangeLaunchCheck {
  check: OrangeLaunchCheck | null;
  /** `fresh` = read from the server just now; `cached` = fetch failed or timed out; `unavailable` = nothing to show. */
  source: "fresh" | "cached" | "unavailable";
}

/**
 * The verdict is re-read from the server right before the launch decision so a
 * test that finished after the wizard was opened (from another tab or
 * operator) is taken into account. The wait is bounded and a failure falls
 * back to the cached check — the operator is warned when possible, never
 * blocked. This function never throws.
 */
export async function resolveOrangeLaunchCheck({
  mtaId,
  fetchValue,
  cached,
  staleAfterDays,
  nowMs = () => Date.now(),
  timeoutMs = ORANGE_LAUNCH_REFRESH_TIMEOUT_MS,
}: ResolveOrangeLaunchCheckOptions): Promise<ResolvedOrangeLaunchCheck> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("orange-launch-check: refresh timed out"));
    }, timeoutMs);
  });
  try {
    const value = await Promise.race([fetchValue(mtaId, controller.signal), timeout]);
    return { check: assessOrangeControlValue(value, { nowMs: nowMs(), staleAfterDays }), source: "fresh" };
  } catch {
    return cached ? { check: cached, source: "cached" } : { check: null, source: "unavailable" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type OrangeLaunchAttemptOutcome = "launched" | "warned" | "abandoned";

/** Shown when an attempt was abandoned because the campaign changed under it. */
export const ORANGE_LAUNCH_ABANDONED_TOAST = {
  title: "Campaign changed, not sent",
  description: "The campaign or its sending server changed while the Orange check was running. Review it and press Send again.",
} as const;

export interface OrangeLaunchAttempt<F extends { mtaId?: string | null }> {
  /** The form exactly as it was when Send was pressed. */
  form: F;
  /** Pre-launch read of the form's server (see `resolveOrangeLaunchCheck`). */
  assess: (mtaId: string) => Promise<OrangeLaunchCheck | null>;
  /** True while the wizard still shows this very form on the launch step. */
  isCurrent: (form: F) => boolean;
  onWarn: (check: OrangeLaunchCheck, form: F) => void;
  onLaunch: (form: F) => void;
}

/**
 * One press of Send. The read and whatever follows it (launch, or warning
 * then "anyway") are bound to the form snapshot the press was made on: if
 * the operator changed the server, edited the campaign or left the launch
 * step while the read was in flight, nothing happens and Send must be
 * pressed again. The wizard can therefore never assess one server and send
 * on another, nor launch after the operator navigated away.
 */
export async function runOrangeLaunchAttempt<F extends { mtaId?: string | null }>(
  attempt: OrangeLaunchAttempt<F>,
): Promise<OrangeLaunchAttemptOutcome> {
  const { form } = attempt;
  const check = form.mtaId ? await attempt.assess(form.mtaId) : null;
  if (!attempt.isCurrent(form)) return "abandoned";
  if (check?.warn) {
    attempt.onWarn(check, form);
    return "warned";
  }
  attempt.onLaunch(form);
  return "launched";
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

export const ORANGE_VERDICT_LABELS: Record<OrangeTestVerdict, string> = {
  GOOD: "GOOD",
  SPAM: "SPAM",
  BLOCKED: "BLOCKED",
  UNKNOWN: "UNKNOWN",
  NOT_RECEIVED: "NOT RECEIVED",
};

/** What a verdict means for the campaign about to be launched (English, like the wizard). */
export const ORANGE_LAUNCH_VERDICT_DETAILS: Record<OrangeTestVerdict, string> = {
  GOOD: "Orange delivered the last test to the Inbox as not-spam.",
  SPAM: "Orange filed the last test in Junk (low spam level): Orange / Wanadoo recipients of this campaign are likely to land in Junk too.",
  BLOCKED: "Orange flagged the last test with a medium or higher spam level: this server is effectively blocked at Orange.",
  UNKNOWN: "The last test arrived but carried no readable X-me-spamlevel header, so Orange's opinion of this server is unknown.",
  NOT_RECEIVED: "The last test never reached the Orange mailbox (Inbox or Junk) within the listening window: Orange may be refusing or silently dropping mail from this server.",
};

/** Coarse relative age: "just now", "5 min ago", "2 h ago", "3 d ago". */
export function formatOrangeAge(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

export type OrangeLaunchTone = "warn" | "ok" | "muted";

export interface OrangeLaunchCheckView {
  tone: OrangeLaunchTone;
  /** One-line summary, e.g. "Latest Orange check: BLOCKED (3 h ago)". */
  headline: string;
  /** Meaning of the state for the launch, or null when nothing needs saying. */
  detail: string | null;
  /** Side notes (newer test pending, refused hand-off). */
  notes: string[];
  /** Badge to render (only for a recent verdict). */
  badgeVerdict: OrangeTestVerdict | null;
  age: string;
}

export function describeOrangeLaunchCheck(check: OrangeLaunchCheck, nowMs: number = Date.now()): OrangeLaunchCheckView {
  const notes: string[] = [];
  if (check.pendingSince) {
    const sentMs = Date.parse(check.pendingSince);
    const since = Number.isFinite(sentMs) ? formatOrangeAge(nowMs - sentMs) : "recently";
    notes.push(`A new Orange Test is in progress (sent ${since}).`);
  }
  if (check.lastSendFailedAt) {
    notes.push("The most recent Orange Test could not be handed to this server (send failed).");
  }

  const age = formatOrangeAge(check.ageMs);
  if (check.status === "recent" && check.verdict) {
    const label = ORANGE_VERDICT_LABELS[check.verdict];
    return {
      tone: check.warn ? "warn" : check.verdict === "GOOD" ? "ok" : "muted",
      headline: `Latest Orange check: ${label} (${age})`,
      detail: check.verdict === "GOOD" ? null : ORANGE_LAUNCH_VERDICT_DETAILS[check.verdict],
      notes,
      badgeVerdict: check.verdict,
      age,
    };
  }
  if (check.status === "stale" && check.verdict) {
    return {
      tone: "muted",
      headline: "No recent Orange check",
      detail: `Last verdict: ${ORANGE_VERDICT_LABELS[check.verdict]}, ${age} — older than ${check.staleAfterDays} day${check.staleAfterDays === 1 ? "" : "s"}.`,
      notes,
      badgeVerdict: null,
      age,
    };
  }
  return {
    tone: "muted",
    headline: "No recent Orange check",
    detail: "No Orange Test has produced a verdict for this server yet.",
    notes,
    badgeVerdict: null,
    age,
  };
}
