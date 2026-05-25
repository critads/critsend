import { db } from "../db";
import { sql, eq, and } from "drizzle-orm";
import { automationWorkflows, automationEnrollments, subscribers, campaigns } from "@shared/schema";
import type { AutomationWorkflow, AutomationEnrollment, TriggerType, Campaign, Mta } from "@shared/schema";
import { logger } from "../logger";
import { isPoolHealthy } from "../db";
import { sendAutomationEmail, sendEmail } from "../email-service";
import { storage } from "../storage";
import { automationQueue } from "../queues";

interface WorkflowStep {
  type: "send_email" | "wait" | "add_tag" | "remove_tag";
  config: {
    subject?: string;
    fromName?: string;
    fromEmail?: string;
    htmlContent?: string;
    duration?: number | string;
    unit?: string;
    tagName?: string;
  };
}

interface WorkflowRow {
  id: string;
  name: string;
  status: string;
  triggerType: string;
  triggerConfig: Record<string, string>;
  steps: WorkflowStep[];
  mtaId: string | null;
}

const AUTOMATION_BATCH_SIZE = 50;
const AUTOMATION_LEASE_MINUTES = 5;

/**
 * Bootstrap migration: ALTER TABLE ... ADD COLUMN IF NOT EXISTS is idempotent
 * and concurrent-safe at the PostgreSQL level. Called explicitly from web
 * (server/index.ts) and worker (server/workers.ts) startup, mirroring the
 * pattern used by runImportBootstrapMigrations, so the migration runs before
 * any route handler or worker poll touches automation tables and there's no
 * implicit module-load ordering to depend on.
 */
let _automationBootstrapPromise: Promise<void> | null = null;
export function runAutomationBootstrapMigrations(): Promise<void> {
  if (_automationBootstrapPromise) return _automationBootstrapPromise;
  _automationBootstrapPromise = (async () => {
    try {
      await db.execute(sql`ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS mta_id varchar`);
      // Task #185: synthetic-campaign id for tracking automation send_email
      // steps. Nullable; populated lazily on first send by
      // `ensureAutomationTrackingCampaign` below.
      await db.execute(sql`ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS tracking_campaign_id varchar`);
      logger.info("[AUTOMATION] Bootstrap migration: mta_id + tracking_campaign_id columns ready");
    } catch (err: any) {
      logger.error(`[AUTOMATION] Bootstrap migration FAILED: ${err?.message || err}`);
    }
  })();
  return _automationBootstrapPromise;
}
// Kick off in the background so module import is non-blocking, but the
// explicit calls in startup paths await completion before serving traffic.
runAutomationBootstrapMigrations().catch(() => {});

/**
 * Notify the automation BullMQ worker (if Redis is configured) to immediately
 * poll for due enrollments. Falls back silently to the periodic poller when
 * Redis isn't available.
 */
async function notifyAutomationWorker(): Promise<void> {
  if (!automationQueue) return;
  try {
    await automationQueue.add(
      "poll",
      { triggeredAt: Date.now() },
      { removeOnComplete: true, removeOnFail: true }
    );
  } catch (err: any) {
    logger.error(`[AUTOMATION] Failed to enqueue BullMQ poll job: ${err?.message || err}`);
  }
}

export async function processAutomationEnrollments(): Promise<number> {
  if (!isPoolHealthy()) return 0;

  let processed = 0;

  try {
    // Atomically claim a batch of due enrollments by pushing nextActionAt forward
    // by a lease window. FOR UPDATE SKIP LOCKED prevents two workers grabbing
    // the same row; if processing crashes, the lease expires and another worker
    // picks it up.
    const claimResult = await db.execute<{
      enrollment_json: AutomationEnrollment;
      workflow_json: AutomationWorkflow;
    }>(sql`
      WITH claimed AS (
        SELECT e.id
        FROM automation_enrollments e
        JOIN automation_workflows w ON w.id = e.workflow_id
        WHERE e.status = 'active'
          AND w.status = 'active'
          AND e.next_action_at <= NOW()
        ORDER BY e.next_action_at ASC
        LIMIT ${AUTOMATION_BATCH_SIZE}
        FOR UPDATE OF e SKIP LOCKED
      )
      UPDATE automation_enrollments e
      SET next_action_at = NOW() + (${sql.raw(String(AUTOMATION_LEASE_MINUTES))} * INTERVAL '1 minute')
      FROM claimed c, automation_workflows w
      WHERE e.id = c.id AND w.id = e.workflow_id
      RETURNING
        to_jsonb(e.*) AS enrollment_json,
        to_jsonb(w.*) AS workflow_json
    `);

    // db.execute() returns a generic QueryResult<Record<string, unknown>>,
    // so a typed cast of `.rows` is the documented drizzle pattern for
    // raw-SQL access. The shape here is fixed by the RETURNING clause above.
    interface ClaimRow {
      enrollment_json: Record<string, unknown>;
      workflow_json: Record<string, unknown>;
    }
    const rows = claimResult.rows as unknown as ClaimRow[];

    for (const row of rows) {
      const enrollment = jsonRowToEnrollment(row.enrollment_json);
      const workflow = jsonRowToWorkflow(row.workflow_json);
      try {
        await processEnrollment(enrollment, workflow);
        processed++;
      } catch (err: any) {
        logger.error(`[AUTOMATION] Error processing enrollment ${enrollment.id}: ${err.message}`);
        await db
          .update(automationEnrollments)
          .set({
            status: "failed",
            lastError: (err.message || "Unknown error").slice(0, 1000),
            completedAt: new Date(),
            nextActionAt: null,
          })
          .where(eq(automationEnrollments.id, enrollment.id));

        await db
          .update(automationWorkflows)
          .set({
            totalFailed: sql`${automationWorkflows.totalFailed} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(automationWorkflows.id, enrollment.workflowId));
      }
    }
  } catch (err: any) {
    logger.error(`[AUTOMATION] Error in enrollment processor: ${err.message}`);
  }

  return processed;
}

function jsonRowToEnrollment(j: Record<string, any>): AutomationEnrollment {
  return {
    id: j.id,
    workflowId: j.workflow_id,
    subscriberId: j.subscriber_id,
    currentStepIndex: j.current_step_index,
    status: j.status,
    enrolledAt: j.enrolled_at ? new Date(j.enrolled_at) : new Date(),
    nextActionAt: j.next_action_at ? new Date(j.next_action_at) : null,
    completedAt: j.completed_at ? new Date(j.completed_at) : null,
    lastError: j.last_error ?? null,
  } as AutomationEnrollment;
}

function jsonRowToWorkflow(j: Record<string, any>): AutomationWorkflow {
  return {
    id: j.id,
    name: j.name,
    description: j.description ?? null,
    status: j.status,
    triggerType: j.trigger_type,
    triggerConfig: j.trigger_config ?? {},
    steps: j.steps ?? [],
    mtaId: j.mta_id ?? null,
    trackingCampaignId: j.tracking_campaign_id ?? null,
    totalEnrolled: j.total_enrolled ?? 0,
    totalCompleted: j.total_completed ?? 0,
    totalFailed: j.total_failed ?? 0,
    createdAt: j.created_at ? new Date(j.created_at) : new Date(),
    updatedAt: j.updated_at ? new Date(j.updated_at) : new Date(),
  } as AutomationWorkflow;
}

/**
 * Pre-step liveness check: re-read enrollment + workflow status from the DB
 * RIGHT BEFORE running any side effects so cancellations/pauses that landed
 * after we claimed the row are honored. There is still a narrow TOCTOU
 * window between this check and the side effect itself (we cannot hold a
 * row lock across a multi-second SMTP send), but this dramatically
 * narrows it. send_email re-checks one more time immediately before the
 * SMTP call to further shrink the window for the most-impactful step.
 */
async function isEnrollmentStillActive(enrollment: AutomationEnrollment, workflow: AutomationWorkflow): Promise<boolean> {
  const [freshEnrollment] = await db
    .select({ status: automationEnrollments.status })
    .from(automationEnrollments)
    .where(eq(automationEnrollments.id, enrollment.id));
  if (!freshEnrollment || freshEnrollment.status !== "active") {
    logger.info(`[AUTOMATION] Enrollment ${enrollment.id.substring(0, 8)} no longer active (status=${freshEnrollment?.status}) — skipping side effects`);
    return false;
  }
  const [freshWorkflow] = await db
    .select({ status: automationWorkflows.status })
    .from(automationWorkflows)
    .where(eq(automationWorkflows.id, workflow.id));
  if (!freshWorkflow || freshWorkflow.status !== "active") {
    logger.info(`[AUTOMATION] Workflow ${workflow.id.substring(0, 8)} not active (status=${freshWorkflow?.status}) — skipping enrollment side effects (lease will expire)`);
    return false;
  }
  return true;
}

async function processEnrollment(enrollment: AutomationEnrollment, workflow: AutomationWorkflow): Promise<void> {
  const steps = (workflow.steps as WorkflowStep[]) || [];
  const stepIndex = enrollment.currentStepIndex;

  if (stepIndex >= steps.length) {
    await markEnrollmentCompleted(enrollment, workflow);
    return;
  }

  // Liveness check immediately before any side effects.
  if (!(await isEnrollmentStillActive(enrollment, workflow))) {
    return;
  }

  const step = steps[stepIndex];
  const logPrefix = `[AUTOMATION] Enrollment ${enrollment.id.substring(0, 8)} step ${stepIndex}/${steps.length}`;

  logger.info(`${logPrefix} Executing ${step.type}`);

  switch (step.type) {
    case "send_email":
      await executeSendEmailStep(enrollment, workflow, step, logPrefix);
      break;
    case "wait":
      await executeWaitStep(enrollment, step, logPrefix);
      return;
    case "add_tag":
      await executeAddTagStep(enrollment, step, logPrefix);
      break;
    case "remove_tag":
      await executeRemoveTagStep(enrollment, step, logPrefix);
      break;
    default: {
      const unknownStep: { type?: string } = step;
      throw new Error(`Unknown step type: ${unknownStep.type ?? "undefined"}`);
    }
  }

  const nextIndex = stepIndex + 1;
  if (nextIndex >= steps.length) {
    await markEnrollmentCompleted(enrollment, workflow);
  } else {
    // Guard on status='active' so a cancellation/pause that landed after we
    // claimed the row (but before/during step execution) is honored — the
    // worker will not advance a no-longer-active enrollment.
    await db
      .update(automationEnrollments)
      .set({
        currentStepIndex: nextIndex,
        nextActionAt: new Date(),
        lastError: null,
      })
      .where(and(
        eq(automationEnrollments.id, enrollment.id),
        eq(automationEnrollments.status, "active"),
      ));
  }
}

async function executeSendEmailStep(
  enrollment: AutomationEnrollment,
  workflow: AutomationWorkflow,
  step: WorkflowStep,
  logPrefix: string
): Promise<void> {
  const { subject, fromName, fromEmail, htmlContent } = step.config;

  if (!subject || !htmlContent) {
    throw new Error("send_email step missing required subject or htmlContent");
  }

  const [subscriber] = await db
    .select()
    .from(subscribers)
    .where(eq(subscribers.id, enrollment.subscriberId));

  if (!subscriber) {
    throw new Error(`Subscriber ${enrollment.subscriberId} not found`);
  }

  if (subscriber.suppressedUntil && new Date(subscriber.suppressedUntil) > new Date()) {
    logger.info(`${logPrefix} Subscriber ${subscriber.email} is suppressed — skipping email`);
    return;
  }

  // Resolve MTA: prefer the workflow's configured MTA; fall back to the
  // account's first available MTA so workflows authored before the mta_id
  // column existed (or via UI paths that haven't yet exposed MTA selection)
  // still execute instead of failing every send_email step.
  let mta = workflow.mtaId ? await storage.getMta(workflow.mtaId) : null;
  if (!mta) {
    const allMtas = await storage.getMtas();
    if (allMtas.length === 0) {
      throw new Error("No MTAs configured — cannot send automation email");
    }
    mta = allMtas[0];
    if (!workflow.mtaId) {
      logger.warn(`${logPrefix} Workflow has no MTA configured; falling back to MTA '${mta.name}' (${mta.id.substring(0, 8)})`);
    } else {
      logger.warn(`${logPrefix} Configured MTA ${workflow.mtaId.substring(0, 8)} not found; falling back to '${mta.name}' (${mta.id.substring(0, 8)})`);
    }
  }

  // Replace {{name}} (an automation-only placeholder) here. Other
  // placeholders ({{email}}, {{subscriber_id}}, {{tags}}) are handled
  // canonically inside `prepareTrackedHtml` via `personalizeContent`.
  const nameReplacedHtml = htmlContent.replace(
    /\{\{name\}\}/gi,
    subscriber.name || subscriber.email,
  );
  const personalizedSubject = subject.replace(
    /\{\{name\}\}/gi,
    subscriber.name || subscriber.email,
  );

  // Final liveness re-check immediately before the SMTP call. This minimizes
  // the window in which a cancellation could be issued but the email is
  // still sent. We cannot eliminate it entirely without holding a row lock
  // across the network call, which would be unacceptable.
  if (!(await isEnrollmentStillActive(enrollment, workflow))) {
    logger.info(`${logPrefix} Cancelled before SMTP dispatch — email NOT sent`);
    return;
  }

  // Task #185: route the automation send through the same `sendEmail`
  // path used by campaign-sender/pressure-guard so opens + clicks +
  // unsubscribe links are tracked. Requires a real `campaigns` row for
  // the FK on `campaign_stats`, so we lazy-create one synthetic campaign
  // per workflow (status='automation_internal', filtered out of the
  // user-facing campaigns list) and reuse it for every send by this
  // workflow.
  const resolvedFromEmail = fromEmail || mta.fromEmail || mta.username || "noreply@example.com";
  const resolvedFromName = fromName || mta.fromName || "Critsend";
  // The synthetic campaign is created ONCE per workflow and only serves
  // as the FK identity target for tracking events (campaign_stats /
  // campaign_sends). We seed it with the raw step template (NOT the
  // per-recipient `{{name}}`-replaced content) so the persisted row
  // never holds another subscriber's personalization.
  const trackingCampaign = await ensureAutomationTrackingCampaign(
    workflow,
    mta,
    {
      fromName: resolvedFromName,
      fromEmail: resolvedFromEmail,
      subject,
      htmlContent,
    },
  );

  if (trackingCampaign) {
    // Build a per-send campaign view that keeps the synthetic campaign's
    // id (so tracking FKs resolve) but carries THIS recipient's
    // personalized subject + html. Without this override sendEmail
    // would render the cached synthetic-row content and leak the first
    // recipient's name to every later recipient.
    const perSendCampaign = {
      ...trackingCampaign,
      fromName: resolvedFromName,
      fromEmail: resolvedFromEmail,
      subject: personalizedSubject,
      htmlContent: nameReplacedHtml,
    };
    const result = await sendEmail(
      mta,
      subscriber,
      perSendCampaign,
      {
        trackOpens: true,
        trackClicks: true,
        trackingDomain: mta.trackingDomain || undefined,
        openTrackingDomain: mta.openTrackingDomain || undefined,
        openTag: trackingCampaign.openTag || undefined,
        clickTag: trackingCampaign.clickTag || undefined,
      },
    );

    if (!result.success) {
      throw new Error(`Email send failed: ${result.error || "Unknown error"}`);
    }

    logger.info(`${logPrefix} Email sent to ${subscriber.email} (messageId: ${result.messageId})`);
    return;
  }

  // Task #185 invariant: every outbound automation email must funnel through
  // `prepareTrackedHtml` so opens/clicks are captured. If we could not
  // provision the synthetic tracking campaign (e.g. missing tracking
  // domain), fail the step instead of silently bypassing tracking. The
  // automation engine's retry/failure machinery will surface this to the
  // user as an actionable error.
  throw new Error(
    "Could not provision tracking campaign for automation send_email step — refusing to send untracked. Check tracking domain configuration.",
  );
}

/**
 * Lazy-create (and cache on the workflow row) a synthetic `campaigns`
 * row used as the FK target for tracking events generated by automation
 * `send_email` steps. The synthetic row uses status='automation_internal'
 * and is filtered out of `getCampaignsPaginated`. Returns null if we
 * could not provision one (caller falls back to untracked send).
 */
async function ensureAutomationTrackingCampaign(
  workflow: AutomationWorkflow,
  mta: Mta,
  step: { fromName: string; fromEmail: string; subject: string; htmlContent: string },
): Promise<Campaign | null> {
  try {
    if (workflow.trackingCampaignId) {
      const [existing] = await db
        .select()
        .from(campaigns)
        .where(eq(campaigns.id, workflow.trackingCampaignId));
      if (existing) {
        return existing;
      }
      // FK target vanished (manual delete?) — fall through and recreate.
    }

    const [inserted] = await db
      .insert(campaigns)
      .values({
        userId: null,
        name: `[automation] ${workflow.name}`,
        mtaId: mta.id,
        segmentId: null,
        fromName: step.fromName,
        fromEmail: step.fromEmail,
        replyEmail: null,
        subject: step.subject,
        preheader: null,
        htmlContent: step.htmlContent,
        trackClicks: true,
        trackOpens: true,
        unsubscribeText: "Unsubscribe",
        companyAddress: null,
        sendingSpeed: "medium",
        status: "automation_internal",
        openTag: null,
        clickTag: null,
        unsubscribeTag: null,
      })
      .returning();

    // Mutate the in-memory workflow so any further send_email steps
    // executed in this same processing pass reuse this row instead of
    // re-inserting another synthetic campaign.
    workflow.trackingCampaignId = inserted.id;

    await db
      .update(automationWorkflows)
      .set({ trackingCampaignId: inserted.id })
      .where(eq(automationWorkflows.id, workflow.id));

    logger.info(`[AUTOMATION] Provisioned tracking campaign ${inserted.id.substring(0, 8)} for workflow ${workflow.id.substring(0, 8)}`);
    return inserted;
  } catch (err: any) {
    logger.warn(`[AUTOMATION] ensureAutomationTrackingCampaign failed: ${err?.message || err} — sending untracked`);
    return null;
  }
}

async function executeWaitStep(
  enrollment: AutomationEnrollment,
  step: WorkflowStep,
  logPrefix: string
): Promise<void> {
  const duration = Number(step.config.duration) || 1;
  const unit = (step.config.unit as string) || "hours";

  let delayMs: number;
  switch (unit) {
    case "minutes":
      delayMs = duration * 60 * 1000;
      break;
    case "hours":
      delayMs = duration * 60 * 60 * 1000;
      break;
    case "days":
      delayMs = duration * 24 * 60 * 60 * 1000;
      break;
    default:
      delayMs = duration * 60 * 60 * 1000;
  }

  const nextActionAt = new Date(Date.now() + delayMs);
  logger.info(`${logPrefix} Wait ${duration} ${unit} — next action at ${nextActionAt.toISOString()}`);

  await db
    .update(automationEnrollments)
    .set({
      currentStepIndex: enrollment.currentStepIndex + 1,
      nextActionAt,
      lastError: null,
    })
    .where(and(
      eq(automationEnrollments.id, enrollment.id),
      eq(automationEnrollments.status, "active"),
    ));
}

async function executeAddTagStep(
  enrollment: AutomationEnrollment,
  step: WorkflowStep,
  logPrefix: string
): Promise<void> {
  const tagName = step.config.tagName as string;
  if (!tagName) {
    throw new Error("add_tag step missing tagName");
  }

  await storage.addTagToSubscriber(enrollment.subscriberId, tagName);
  logger.info(`${logPrefix} Added tag '${tagName}' to subscriber ${enrollment.subscriberId.substring(0, 8)}`);

  // Emit tag_added trigger so chained workflows can auto-enroll on tags
  // applied by the automation engine itself (not just the tracking-side path).
  checkAndEnrollForTrigger("tag_added", enrollment.subscriberId, { tagName }).catch(() => {});
}

async function executeRemoveTagStep(
  enrollment: AutomationEnrollment,
  step: WorkflowStep,
  logPrefix: string
): Promise<void> {
  const tagName = step.config.tagName as string;
  if (!tagName) {
    throw new Error("remove_tag step missing tagName");
  }

  await db.execute(sql`
    UPDATE subscribers
    SET tags = array_remove(tags, ${tagName})
    WHERE id = ${enrollment.subscriberId}
  `);
  logger.info(`${logPrefix} Removed tag '${tagName}' from subscriber ${enrollment.subscriberId.substring(0, 8)}`);

  // Emit tag_removed trigger so downstream workflows configured for this
  // event can auto-enroll. The automation engine itself is currently the
  // only runtime path that removes tags from a subscriber, so this is the
  // only place tag_removed needs to be wired.
  checkAndEnrollForTrigger("tag_removed", enrollment.subscriberId, { tagName }).catch(() => {});
}

async function markEnrollmentCompleted(enrollment: AutomationEnrollment, workflow: AutomationWorkflow): Promise<void> {
  // Conditional update: only complete enrollments that are still active. If a
  // user cancelled the enrollment after we claimed it, the cancellation wins.
  // .returning() gives us a typed array we can check for affected rows
  // without resorting to driver-specific .rowCount on an `any`-typed result.
  const completed = await db
    .update(automationEnrollments)
    .set({
      status: "completed",
      completedAt: new Date(),
      nextActionAt: null,
      lastError: null,
    })
    .where(and(
      eq(automationEnrollments.id, enrollment.id),
      eq(automationEnrollments.status, "active"),
    ))
    .returning({ id: automationEnrollments.id });

  if (completed.length === 0) {
    logger.info(`[AUTOMATION] Enrollment ${enrollment.id.substring(0, 8)} no longer active — skipping completion (was likely cancelled)`);
    return;
  }

  await db
    .update(automationWorkflows)
    .set({
      totalCompleted: sql`${automationWorkflows.totalCompleted} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(automationWorkflows.id, workflow.id));

  logger.info(`[AUTOMATION] Enrollment ${enrollment.id.substring(0, 8)} completed all steps for workflow '${workflow.name}'`);
}

/**
 * Batch dispatcher: emits subscriber_added trigger for every newly inserted
 * subscriber from a bulk import. Fire-and-forget per ID so a single workflow
 * failure doesn't stall the import; per-call errors are logged inside
 * checkAndEnrollForTrigger.
 */
export function dispatchSubscriberAddedTriggers(subscriberIds: string[]): void {
  if (!subscriberIds || subscriberIds.length === 0) return;
  for (const id of subscriberIds) {
    checkAndEnrollForTrigger("subscriber_added", id, {}).catch((err: any) => {
      logger.error(`[AUTOMATION] subscriber_added dispatch failed for ${id.substring(0, 8)}: ${err?.message || err}`);
    });
  }
}

export async function checkAndEnrollForTrigger(
  triggerType: TriggerType,
  subscriberId: string,
  context: { tagName?: string; campaignId?: string } = {}
): Promise<void> {
  try {
    const activeWorkflows = await db
      .select()
      .from(automationWorkflows)
      .where(
        and(
          eq(automationWorkflows.status, "active"),
          eq(automationWorkflows.triggerType, triggerType)
        )
      );

    if (activeWorkflows.length === 0) return;

    for (const workflow of activeWorkflows) {
      if (!matchesTriggerConfig(workflow, triggerType, context)) continue;

      try {
        // INSERT ... ON CONFLICT DO NOTHING RETURNING — only increment counter
        // when a row is actually inserted, so concurrent triggers cannot
        // overcount totalEnrolled.
        const insertResult = await db.execute(sql`
          INSERT INTO automation_enrollments
            (workflow_id, subscriber_id, status, next_action_at, current_step_index)
          VALUES (${workflow.id}, ${subscriberId}, 'active', NOW(), 0)
          ON CONFLICT DO NOTHING
          RETURNING id
        `);

        if (insertResult.rows.length > 0) {
          await db
            .update(automationWorkflows)
            .set({
              totalEnrolled: sql`${automationWorkflows.totalEnrolled} + 1`,
              updatedAt: new Date(),
            })
            .where(eq(automationWorkflows.id, workflow.id));

          logger.info(
            `[AUTOMATION] Enrolled subscriber ${subscriberId.substring(0, 8)} in workflow '${workflow.name}' (trigger: ${triggerType})`
          );

          // Wake the BullMQ automation worker so the new enrollment is processed
          // immediately rather than waiting for the next periodic poll. Falls
          // back to the periodic poller when Redis is not configured.
          notifyAutomationWorker().catch(() => {});
        }
      } catch (err: any) {
        if (err?.code === "23505") continue;
        logger.error(`[AUTOMATION] Failed to enroll subscriber ${subscriberId.substring(0, 8)} in workflow ${workflow.id}: ${err.message}`);
      }
    }
  } catch (err: any) {
    logger.error(`[AUTOMATION] Error checking triggers for ${triggerType}: ${err.message}`);
  }
}

function matchesTriggerConfig(
  workflow: AutomationWorkflow,
  triggerType: TriggerType,
  context: { tagName?: string; campaignId?: string }
): boolean {
  const config = (workflow.triggerConfig as Record<string, string>) || {};

  switch (triggerType) {
    case "subscriber_added":
      return true;
    case "tag_added":
    case "tag_removed":
      return !config.tagName || config.tagName === context.tagName;
    case "subscriber_opened":
    case "subscriber_clicked":
      return !config.campaignId || config.campaignId === context.campaignId;
    default:
      return false;
  }
}
