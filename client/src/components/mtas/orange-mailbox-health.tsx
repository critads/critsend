import { CheckCircle2, MailWarning, Inbox } from "lucide-react";
import type { OrangeMailboxHealthView, OrangeTestPublicConfig } from "@shared/orange-test";
import { formatDateTime, formatDuration } from "./orange-test";

const ERROR_CLASS_LABEL: Record<NonNullable<OrangeMailboxHealthView["lastErrorClass"]>, string> = {
  AUTH: "authentication refused",
  NETWORK: "network",
  TIMEOUT: "timeout",
  IMAP: "IMAP error",
  UNKNOWN: "error",
};

/**
 * Health of the Orange mailbox connection, shown once at the top of /mtas.
 * While the mailbox cannot be read, no pending test is actually being
 * checked — without this indicator every test would silently end as
 * NOT CHECKED and an operator could read that as an MTA problem.
 */
export function OrangeMailboxHealthBanner({
  config,
  health,
  now = Date.now(),
}: {
  config: OrangeTestPublicConfig | undefined;
  health: OrangeMailboxHealthView | undefined;
  now?: number;
}) {
  if (!config?.enabled || !health) return null;

  if (health.state === "failing") {
    const since = health.failingSince ? new Date(health.failingSince).getTime() : null;
    return (
      <div
        className="flex items-start gap-3 p-4 rounded-lg border border-amber-300 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:border-amber-800 dark:text-amber-200"
        role="alert"
        data-testid="orange-mailbox-health-failing"
      >
        <MailWarning className="h-5 w-5 mt-0.5 shrink-0" />
        <div className="min-w-0 space-y-1.5 text-sm">
          <p className="font-semibold">
            Orange mailbox unreadable — Orange tests are not being checked
            {health.lastErrorClass && (
              <span className="ml-2 inline-flex items-center rounded border border-amber-400 px-1.5 py-0.5 text-xs font-mono uppercase" data-testid="orange-mailbox-health-error-class">
                {health.lastErrorClass}
              </span>
            )}
          </p>
          <p>
            <span className="font-mono">{health.mailbox}</span> has failed {health.consecutiveFailures} consecutive check
            {health.consecutiveFailures === 1 ? "" : "s"} ({health.lastErrorClass ? ERROR_CLASS_LABEL[health.lastErrorClass] : "error"})
            since {formatDateTime(health.failingSince)}
            {since !== null ? ` — ${formatDuration(now - since)} ago` : ""}. Last successful read:{" "}
            <span data-testid="orange-mailbox-health-last-success">{health.lastSuccessAt ? formatDateTime(health.lastSuccessAt) : "never"}</span>.
          </p>
          <p>
            Tests reaching the end of their listening window meanwhile close as <span className="font-semibold">NOT CHECKED</span>, not
            as NOT RECEIVED: they say nothing about the MTAs. Fix the mailbox access, then run the tests again.
          </p>
          {health.lastErrorMessage && (
            <p className="font-mono text-xs break-words opacity-90" data-testid="orange-mailbox-health-error">
              {health.lastErrorMessage}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid={`orange-mailbox-health-${health.state}`}>
      {health.state === "ok" ? (
        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
      ) : (
        <Inbox className="h-3.5 w-3.5 shrink-0" />
      )}
      <span>
        Orange mailbox <span className="font-mono">{health.mailbox}</span>
        {health.state === "ok" ? (
          <>
            {" "}· last read <span data-testid="orange-mailbox-health-last-success">{formatDateTime(health.lastSuccessAt)}</span>
            {health.lastFailureAt && health.lastErrorClass ? ` · previous failure ${formatDateTime(health.lastFailureAt)} (${health.lastErrorClass})` : ""}
          </>
        ) : (
          <> · not read yet (the mailbox is only opened while a test is listening)</>
        )}
      </span>
    </div>
  );
}
