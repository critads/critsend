import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assessOrangeControlValue,
  ORANGE_LAUNCH_WARNING_VERDICTS,
  ORANGE_TEST_DEFAULT_STALE_VERDICT_DAYS,
  type OrangeTestControlValue,
  type OrangeTestStatus,
  type OrangeTestVerdict,
  type OrangeTestView,
} from "../shared/orange-test";
import {
  describeOrangeLaunchCheck,
  formatOrangeAge,
  resolveOrangeLaunchCheck,
  runOrangeLaunchAttempt,
} from "../client/src/lib/orange-launch-check";
import { chunkOrangeSummaryIds, fetchOrangeTestSummary, normalizeOrangeSummaryIds } from "../client/src/lib/orange-test-summary";

const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const HOUR = 3600_000;
const DAY = 24 * HOUR;

function test(overrides: Partial<OrangeTestView> & { sentAgoMs?: number }): OrangeTestView {
  const { sentAgoMs = HOUR, ...rest } = overrides;
  const sentAt = new Date(NOW - sentAgoMs).toISOString();
  return {
    id: rest.id ?? `t-${sentAgoMs}`,
    mtaId: "mta-1",
    reference: "OT-x",
    messageId: "<x@y>",
    status: "done",
    verdict: "GOOD",
    spamLevelRaw: "not-spam",
    foundIn: "inbox",
    foundFolder: "INBOX",
    matchedBy: "message-id",
    rawHeaders: null,
    mailbox: "box@orange.fr",
    fromEmail: "news@example.test",
    requestedBy: null,
    sendError: null,
    sendNote: null,
    lastCheckError: null,
    lastCheckAt: null,
    pollCount: 1,
    createdAt: new Date(NOW - sentAgoMs - 5_000).toISOString(),
    sentAt,
    nextPollAt: null,
    deadlineAt: null,
    receivedAt: sentAt,
    finishedAt: sentAt,
    deliveryDelayMs: 0,
    ...rest,
  };
}

function control(latestVerdict: OrangeTestView | null, latest: OrangeTestView | null = latestVerdict): OrangeTestControlValue {
  return { latest, latestVerdict };
}

describe("assessOrangeControlValue", () => {
  it("reports no check when the MTA never produced a verdict (missing entry, null, or pending only)", () => {
    for (const value of [undefined, null, control(null), control(null, test({ status: "waiting", verdict: null }))]) {
      const check = assessOrangeControlValue(value, { nowMs: NOW });
      expect(check.status).toBe("none");
      expect(check.verdict).toBeNull();
      expect(check.warn).toBe(false);
      expect(check.staleAfterDays).toBe(ORANGE_TEST_DEFAULT_STALE_VERDICT_DAYS);
    }
  });

  it("keeps a recent GOOD or UNKNOWN verdict informational and counts age from the send time", () => {
    const good = assessOrangeControlValue(control(test({ verdict: "GOOD", sentAgoMs: 2 * HOUR })), { nowMs: NOW });
    expect(good).toMatchObject({ status: "recent", verdict: "GOOD", warn: false, ageMs: 2 * HOUR });
    const unknown = assessOrangeControlValue(control(test({ verdict: "UNKNOWN", spamLevelRaw: null, sentAgoMs: 3 * DAY })), { nowMs: NOW });
    expect(unknown).toMatchObject({ status: "recent", verdict: "UNKNOWN", warn: false, ageMs: 3 * DAY });
  });

  it.each(ORANGE_LAUNCH_WARNING_VERDICTS)("warns on a recent %s verdict without ever blocking", (verdict) => {
    const status: OrangeTestStatus = verdict === "NOT_RECEIVED" ? "not_received" : "done";
    const check = assessOrangeControlValue(control(test({ verdict, status, sentAgoMs: 6 * DAY })), { nowMs: NOW });
    expect(check.status).toBe("recent");
    expect(check.verdict).toBe(verdict);
    expect(check.warn).toBe(true);
  });

  it("turns a verdict older than the window into 'no recent check' and drops the warning", () => {
    const stale = assessOrangeControlValue(control(test({ verdict: "BLOCKED", sentAgoMs: 8 * DAY })), { nowMs: NOW });
    expect(stale).toMatchObject({ status: "stale", verdict: "BLOCKED", warn: false, ageMs: 8 * DAY, staleAfterDays: 7 });
    // The window is configurable: 10 days keeps the same verdict recent.
    const widened = assessOrangeControlValue(control(test({ verdict: "BLOCKED", sentAgoMs: 8 * DAY })), { nowMs: NOW, staleAfterDays: 10 });
    expect(widened).toMatchObject({ status: "recent", warn: true, staleAfterDays: 10 });
    // Exactly at the boundary the verdict is still recent.
    const edge = assessOrangeControlValue(control(test({ verdict: "SPAM", sentAgoMs: 7 * DAY })), { nowMs: NOW });
    expect(edge.status).toBe("recent");
    expect(edge.warn).toBe(true);
    // Nonsense windows fall back to the default rather than hiding every verdict.
    expect(assessOrangeControlValue(control(test({ verdict: "SPAM" })), { nowMs: NOW, staleAfterDays: 0 }).staleAfterDays).toBe(7);
  });

  it("uses the most recently SENT verdict even while a newer test is pending, and notes the pending test", () => {
    const previous = test({ id: "old", verdict: "SPAM", sentAgoMs: 5 * HOUR });
    const pending = test({ id: "new", status: "waiting", verdict: null, sentAgoMs: 40 * 60_000, receivedAt: null, finishedAt: null });
    const check = assessOrangeControlValue(control(previous, pending), { nowMs: NOW });
    expect(check).toMatchObject({ status: "recent", verdict: "SPAM", warn: true, ageMs: 5 * HOUR });
    expect(check.pendingSince).toBe(pending.sentAt);
    expect(check.lastSendFailedAt).toBeNull();
  });

  it("never treats a refused hand-off as a verdict but reports it next to the last real verdict", () => {
    const previous = test({ id: "old", verdict: "GOOD", sentAgoMs: 2 * DAY });
    const failed = test({ id: "new", status: "failed", verdict: null, sentAt: null, sentAgoMs: HOUR, receivedAt: null, finishedAt: null });
    const check = assessOrangeControlValue(control(previous, failed), { nowMs: NOW });
    expect(check).toMatchObject({ status: "recent", verdict: "GOOD", warn: false });
    expect(check.lastSendFailedAt).toBe(failed.createdAt);
    expect(check.pendingSince).toBeNull();
  });

  it("falls back to createdAt when sentAt is missing and ignores unparseable dates", () => {
    const noSentAt = test({ verdict: "BLOCKED", sentAt: null, sentAgoMs: HOUR });
    const check = assessOrangeControlValue(control(noSentAt), { nowMs: NOW });
    expect(check.status).toBe("recent");
    expect(check.verdictAt).toBe(noSentAt.createdAt);
    const broken = test({ verdict: "BLOCKED", sentAt: "not-a-date", createdAt: "still-not-a-date" });
    expect(assessOrangeControlValue(control(broken), { nowMs: NOW }).status).toBe("none");
  });
});

describe("Orange launch check presentation", () => {
  it("formats ages coarsely", () => {
    expect(formatOrangeAge(null)).toBe("—");
    expect(formatOrangeAge(20_000)).toBe("just now");
    expect(formatOrangeAge(5 * 60_000)).toBe("5 min ago");
    expect(formatOrangeAge(2 * HOUR + 10 * 60_000)).toBe("2 h ago");
    expect(formatOrangeAge(47 * HOUR)).toBe("47 h ago");
    expect(formatOrangeAge(3 * DAY + HOUR)).toBe("3 d ago");
  });

  it("words each state for the operator", () => {
    const blocked = describeOrangeLaunchCheck(assessOrangeControlValue(control(test({ verdict: "BLOCKED", sentAgoMs: 3 * HOUR })), { nowMs: NOW }), NOW);
    expect(blocked.tone).toBe("warn");
    expect(blocked.headline).toBe("Latest Orange check: BLOCKED (3 h ago)");
    expect(blocked.detail).toMatch(/effectively blocked/);
    expect(blocked.badgeVerdict).toBe("BLOCKED");

    const good = describeOrangeLaunchCheck(assessOrangeControlValue(control(test({ verdict: "GOOD", sentAgoMs: HOUR })), { nowMs: NOW }), NOW);
    expect(good.tone).toBe("ok");
    expect(good.detail).toBeNull();

    const stale = describeOrangeLaunchCheck(assessOrangeControlValue(control(test({ verdict: "SPAM", sentAgoMs: 12 * DAY })), { nowMs: NOW }), NOW);
    expect(stale.tone).toBe("muted");
    expect(stale.headline).toBe("No recent Orange check");
    expect(stale.detail).toBe("Last verdict: SPAM, 12 d ago — older than 7 days.");
    expect(stale.badgeVerdict).toBeNull();

    const none = describeOrangeLaunchCheck(assessOrangeControlValue(undefined, { nowMs: NOW }), NOW);
    expect(none.headline).toBe("No recent Orange check");
    expect(none.detail).toMatch(/No Orange Test has produced a verdict/);

    const pending = test({ id: "new", status: "waiting", verdict: null, sentAgoMs: 40 * 60_000 });
    const withPending = describeOrangeLaunchCheck(
      assessOrangeControlValue(control(test({ id: "old", verdict: "NOT_RECEIVED", status: "not_received", sentAgoMs: 3 * DAY }), pending), { nowMs: NOW }),
      NOW,
    );
    expect(withPending.tone).toBe("warn");
    expect(withPending.notes).toEqual(["A new Orange Test is in progress (sent 40 min ago)."]);
  });

  it("covers every verdict with a label and a launch-time explanation", async () => {
    const { ORANGE_LAUNCH_VERDICT_DETAILS, ORANGE_VERDICT_LABELS } = await import("../client/src/lib/orange-launch-check");
    const verdicts: OrangeTestVerdict[] = ["GOOD", "SPAM", "BLOCKED", "UNKNOWN", "NOT_RECEIVED"];
    for (const verdict of verdicts) {
      expect(ORANGE_VERDICT_LABELS[verdict]).toBeTruthy();
      expect(ORANGE_LAUNCH_VERDICT_DETAILS[verdict]).toBeTruthy();
    }
  });
});

describe("pre-launch refresh (verdict may change after the wizard opened)", () => {
  const staleAfterDays = 7;
  const cachedGood = assessOrangeControlValue(control(test({ verdict: "GOOD", sentAgoMs: 2 * DAY })), { nowMs: NOW });

  it("re-reads the selected MTA and decides on the fresh verdict, not the displayed one", async () => {
    const seen: string[] = [];
    const resolved = await resolveOrangeLaunchCheck({
      mtaId: "mta-1",
      cached: cachedGood,
      staleAfterDays,
      nowMs: () => NOW,
      fetchValue: async (id) => {
        seen.push(id);
        return control(test({ verdict: "BLOCKED", sentAgoMs: 20 * 60_000 }));
      },
    });
    expect(seen).toEqual(["mta-1"]);
    expect(resolved.source).toBe("fresh");
    expect(resolved.check).toMatchObject({ status: "recent", verdict: "BLOCKED", warn: true });
    // And the other way round: a warned display cleared by a fresh GOOD test no longer asks.
    const cleared = await resolveOrangeLaunchCheck({
      mtaId: "mta-1",
      cached: assessOrangeControlValue(control(test({ verdict: "SPAM", sentAgoMs: DAY })), { nowMs: NOW }),
      staleAfterDays,
      nowMs: () => NOW,
      fetchValue: async () => control(test({ verdict: "GOOD", sentAgoMs: HOUR })),
    });
    expect(cleared.check?.warn).toBe(false);
  });

  it("falls back to the displayed check when the refresh fails, and to 'no check' when there is none — never throws", async () => {
    const failed = await resolveOrangeLaunchCheck({
      mtaId: "mta-1",
      cached: cachedGood,
      staleAfterDays,
      fetchValue: async () => {
        throw new Error("503");
      },
    });
    expect(failed).toEqual({ check: cachedGood, source: "cached" });
    const nothing = await resolveOrangeLaunchCheck({
      mtaId: "mta-1",
      cached: null,
      staleAfterDays,
      fetchValue: async () => {
        throw new Error("503");
      },
    });
    expect(nothing).toEqual({ check: null, source: "unavailable" });
  });

  it("bounds the wait: a hanging server is aborted and the launch goes on with what is displayed", async () => {
    let aborted = false;
    const started = Date.now();
    const resolved = await resolveOrangeLaunchCheck({
      mtaId: "mta-1",
      cached: cachedGood,
      staleAfterDays,
      timeoutMs: 50,
      fetchValue: (_id, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(aborted).toBe(true);
    expect(resolved).toEqual({ check: cachedGood, source: "cached" });
  });
});

describe("a press of Send is bound to the form it was pressed on", () => {
  type Form = { mtaId?: string; name: string };
  const warned = assessOrangeControlValue(control(test({ verdict: "SPAM", sentAgoMs: HOUR })), { nowMs: NOW });
  const fine = assessOrangeControlValue(control(test({ verdict: "GOOD", sentAgoMs: HOUR })), { nowMs: NOW });

  function wizard(initial: Form) {
    // Simulates the pages' live refs: the form on screen and the current step.
    const live = { form: initial, step: 5 };
    const events: string[] = [];
    let release: (check: typeof warned | null) => void = () => {};
    const attempt = runOrangeLaunchAttempt<Form>({
      form: live.form,
      assess: (mtaId) => {
        events.push(`assess:${mtaId}`);
        return new Promise((resolve) => {
          release = resolve;
        });
      },
      isCurrent: (form) => live.form === form && live.step === 5,
      onWarn: (check, form) => events.push(`warn:${check.verdict}:${form.mtaId}`),
      onLaunch: (form) => events.push(`launch:${form.mtaId}`),
    });
    return { live, events, attempt, release: (check: typeof warned | null) => release(check) };
  }

  it("launches or warns for the assessed server when nothing changed during the read", async () => {
    const a = wizard({ mtaId: "A", name: "n" });
    a.release(fine);
    expect(await a.attempt).toBe("launched");
    expect(a.events).toEqual(["assess:A", "launch:A"]);
    const b = wizard({ mtaId: "A", name: "n" });
    b.release(warned);
    expect(await b.attempt).toBe("warned");
    expect(b.events).toEqual(["assess:A", "warn:SPAM:A"]);
  });

  it("does nothing when the operator switched to another server while A was being read", async () => {
    const w = wizard({ mtaId: "A", name: "n" });
    w.live.form = { mtaId: "B", name: "n" }; // selection changed during the wait
    w.release(warned);
    expect(await w.attempt).toBe("abandoned");
    expect(w.events).toEqual(["assess:A"]); // no warning about A next to B, no send on B
  });

  it("does nothing when the operator navigated away from the Schedule step, even for a GOOD verdict", async () => {
    const w = wizard({ mtaId: "A", name: "n" });
    w.live.step = 4;
    w.release(fine);
    expect(await w.attempt).toBe("abandoned");
    expect(w.events).toEqual(["assess:A"]);
  });

  it("does nothing when any field of the campaign was edited during the read", async () => {
    const w = wizard({ mtaId: "A", name: "n" });
    w.live.form = { ...w.live.form, name: "renamed" };
    w.release(null); // even an unavailable check
    expect(await w.attempt).toBe("abandoned");
    expect(w.events).toEqual(["assess:A"]);
  });

  it("skips the read entirely when no server is selected and launches the same snapshot", async () => {
    const form: Form = { name: "n" };
    const events: string[] = [];
    const outcome = await runOrangeLaunchAttempt<Form>({
      form,
      assess: async () => {
        throw new Error("must not be called");
      },
      isCurrent: (f) => f === form,
      onWarn: () => events.push("warn"),
      onLaunch: (f) => events.push(f === form ? "launch:same" : "launch:other"),
    });
    expect(outcome).toBe("launched");
    expect(events).toEqual(["launch:same"]);
  });
});

describe("summary requests beyond the route's id limit", () => {
  it("splits long id lists so a selected MTA past the 200th is still assessed", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `mta-${String(i).padStart(3, "0")}`);
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      const requested = decodeURIComponent(url.split("ids=")[1]).split(",");
      // Mirror the route: anything past the limit is silently ignored.
      expect(requested.length).toBeLessThanOrEqual(200);
      const values = Object.fromEntries(requested.map((id) => [id, control(test({ id, verdict: "GOOD" }))]));
      return new Response(JSON.stringify({ values }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const values = await fetchOrangeTestSummary(ids, { fetchImpl });
    expect(urls).toHaveLength(2);
    expect(Object.keys(values)).toHaveLength(250);
    expect(values["mta-230"]?.latestVerdict?.verdict).toBe("GOOD");
  });

  it("normalises and chunks ids deterministically and surfaces HTTP errors", async () => {
    expect(normalizeOrangeSummaryIds(["b", "a", "b", ""])).toEqual(["a", "b"]);
    expect(chunkOrangeSummaryIds(["a", "b", "c"], 2)).toEqual([["a", "b"], ["c"]]);
    expect(await fetchOrangeTestSummary([], { fetchImpl: (() => { throw new Error("must not be called"); }) as typeof fetch })).toEqual({});
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    await expect(fetchOrangeTestSummary(["a"], { fetchImpl })).rejects.toThrow(/500/);
  });

  it("keeps the route's limit and the client's chunk size in one shared constant", () => {
    const route = readFileSync(new URL("../server/routes/mtas.ts", import.meta.url), "utf8");
    expect(route).toContain("ids.slice(0, ORANGE_TEST_SUMMARY_MAX_IDS)");
    const summaryLib = readFileSync(new URL("../client/src/lib/orange-test-summary.ts", import.meta.url), "utf8");
    expect(summaryLib).toContain("chunkSize = ORANGE_TEST_SUMMARY_MAX_IDS");
  });
});

describe("campaign wizard wiring", () => {
  const newPage = readFileSync(new URL("../client/src/pages/campaign-new.tsx", import.meta.url), "utf8");
  const editPage = readFileSync(new URL("../client/src/pages/campaign-edit.tsx", import.meta.url), "utf8");
  const component = readFileSync(new URL("../client/src/components/campaign-wizard/orange-launch-check.tsx", import.meta.url), "utf8");

  it.each([
    ["creation", newPage],
    ["editing", editPage],
  ])("shows the verdict in the selector and on the Schedule step, and asks before a warned launch while %s", (_screen, source) => {
    expect(source).toContain('from "@/components/campaign-wizard/orange-launch-check"');
    expect(source).toContain("<OrangeLaunchCheckChip mtaId={mta.id} check={orangeChecks.checks?.[mta.id]} />");
    expect(source).toContain("<OrangeLaunchCheckPanel mta={launchMta} check={launchOrangeCheck} isError={orangeChecks.isError} />");
    expect(source).toContain("<OrangeLaunchConfirmDialog");
    // The selected server is always assessed, even when it is no longer active.
    expect(source).toContain("if (formData.mtaId && !ids.includes(formData.mtaId)) ids.push(formData.mtaId);");
    // Entering the Schedule step re-reads the verdicts.
    expect(source).toContain("if (currentStep === 5) refreshOrangeChecks();");
    // The launch decision is taken on a fresh read of the selected server, bound
    // to the form snapshot Send was pressed on (live form/step read through refs)...
    const handler = source.slice(source.indexOf("const handleSend = async () => {"), source.indexOf("const confirmOrangeLaunch = "));
    expect(handler).toContain("await runOrangeLaunchAttempt({");
    expect(handler).toContain("form: formData,");
    expect(handler).toContain("assess: orangeChecks.assessBeforeLaunch,");
    expect(handler).toContain("isCurrent: isLaunchCurrent,");
    expect(handler).toContain("onWarn: (check, form) => setOrangeConfirm({ check, form }),");
    expect(handler).toContain("onLaunch: (form) => sendMutation.mutate(form),");
    expect(handler).toContain('if (outcome === "abandoned") toast(ORANGE_LAUNCH_ABANDONED_TOAST);');
    expect(source).toContain("(form: CampaignFormData) => formDataRef.current === form && currentStepRef.current === 5");
    expect(source).toContain("formDataRef.current = formData;");
    expect(source).toContain("currentStepRef.current = currentStep;");
    // ...the button cannot be double-fired while that read is in flight...
    expect(source).toMatch(/disabled=\{sendMutation\.isPending[^}]*orangeChecks\.launchCheckPending\}/);
    // ...the dialog shows the check and server it was read for, and confirming
    // sends that same snapshot, or nothing if the form changed meanwhile.
    expect(source).toContain("open={orangeConfirm !== null}");
    expect(source).toContain("check={orangeConfirm?.check}");
    expect(source).toContain("mtaName={orangeConfirmMtaName}");
    expect(source).toContain("mtas?.find((m) => m.id === orangeConfirm.form.mtaId)?.name");
    const confirm = source.slice(source.indexOf("const confirmOrangeLaunch = "), source.indexOf("const confirmOrangeLaunch = ") + 320);
    expect(confirm).toContain("if (!isLaunchCurrent(pending.form)) {");
    expect(confirm).toContain("sendMutation.mutate(pending.form);");
    expect(confirm).not.toContain("sendMutation.mutate(formData)");
  });

  it("reuses the /mtas control values and verdict badge, but re-reads them while the wizard stays open", () => {
    expect(component).toContain('from "@/components/mtas/orange-test"');
    expect(component).toContain("useOrangeTestSummary(mtaIds, mtaIds.length > 0, {");
    expect(component).toContain("staleTime: ORANGE_LAUNCH_SUMMARY_STALE_MS");
    expect(component).toContain("refetchOnWindowFocus: true");
    expect(component).toContain("idleRefetchIntervalMs: ORANGE_LAUNCH_SUMMARY_REFETCH_MS");
    expect(component).toContain("config.data?.staleVerdictDays ?? ORANGE_TEST_DEFAULT_STALE_VERDICT_DAYS");
    expect(component).toContain("<OrangeVerdictBadge");
    // The pre-launch read goes through the bounded resolver and only asks for the selected server.
    expect(component).toContain("resolveOrangeLaunchCheck({");
    expect(component).toContain("fetchOrangeTestSummary([id], { signal })");
    // Never a hard block: without a warned check the dialog renders nothing and
    // it does not depend on the MTA list being loaded.
    expect(component).toContain("if (!check || !check.warn || !check.verdict) return null;");
    expect(component).toContain('{mtaName || "the selected server"}');
    expect(component).toContain("{actionLabel} anyway");
  });

  it("keeps the /mtas page on its previous polling behaviour", () => {
    const mtasHook = readFileSync(new URL("../client/src/components/mtas/orange-test.tsx", import.meta.url), "utf8");
    expect(mtasHook).toContain("return pending ? 30_000 : opts.idleRefetchIntervalMs ?? false;");
    const mtasPage = readFileSync(new URL("../client/src/pages/mtas.tsx", import.meta.url), "utf8");
    expect(mtasPage).toContain("useOrangeTestSummary(visibleMtaIds, true)");
  });
});
