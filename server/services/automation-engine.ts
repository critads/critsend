import { db } from "../db";
import { sql, eq, and } from "drizzle-orm";
import { automationWorkflows, automationEnrollments, subscribers } from "@shared/schema";
import type { AutomationWorkflow, AutomationEnrollment, TriggerType } from "@shared/schema";
import { logger } from "../logger";
import { isPoolHealthy } from "../db";
import { sendAutomationEmail } from "../email-service";
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

// Bootstrap migration: ALTER TABLE ... ADD COLUMN IF NOT EXISTS is idempotent
// and concurrent-safe at the PostgreSQL level. Runs once per process at module
// load (web + worker) before the engine begins polling.
(async () => {
  try {
    await db.execute(sql`ALTER TABLE automation_workflows ADD COLUMN IF NOT EXISTS mta_id varchar`);
    logger.info("[AUTOMATION] Bootstrap migration: mta_id column ready");
  } catch (err: any) {
    logger.error(`[AUTOMATION] Bootstrap migration FAILED (mta_id): ${err?.message || err}`);
  }
})();

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

    const rows = claimResult.rows as unknown as Array<{
      enrollment_json: any;
      workflow_json: any;
    }>;

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

function jsonRowToEnrollment(j: any): AutomationEnrollment {
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

function jsonRowToWorkflow(j: any): AutomationWorkflow {
  return {
    id: j.id,
    name: j.name,
    description: j.description ?? null,
    status: j.status,
    triggerType: j.trigger_type,
    triggerConfig: j.trigger_config ?? {},
    steps: j.steps ?? [],
    mtaId: j.mta_id ?? null,
    totalEnrolled: j.total_enrolled ?? 0,
    totalCompleted: j.total_completed ?? 0,
    totalFailed: j.total_failed ?? 0,
    createdAt: j.created_at ? new Date(j.created_at) : new Date(),
    updatedAt: j.updated_at ? new Date(j.updated_at) : new Date(),
  } as AutomationWorkflow;
}

async function processEnrollment(enrollment: AutomationEnrollment, workflow: AutomationWorkflow): Promise<void> {
  const steps = (workflow.steps as WorkflowStep[]) || [];
  const stepIndex = enrollment.currentStepIndex;

  if (stepIndex >= steps.length) {
    await markEnrollmentCompleted(enrollment, workflow);
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
    default:
      throw new Error(`Unknown step type: ${(step as any).type}`);
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

  const mtaId = workflow.mtaId;
  if (!mtaId) {
    throw new Error("Workflow has no MTA configured for email sending");
  }

  const mta = await storage.getMta(mtaId);
  if (!mta) {
    throw new Error(`MTA ${mtaId} not found`);
  }

  const personalizedHtml = htmlContent
    .replace(/\{\{email\}\}/gi, subscriber.email)
    .replace(/\{\{name\}\}/gi, subscriber.name || subscriber.email);

  const personalizedSubject = subject
    .replace(/\{\{email\}\}/gi, subscriber.email)
    .replace(/\{\{name\}\}/gi, subscriber.name || subscriber.email);

  const result = await sendAutomationEmail(mta, {
    to: subscriber.email,
    fromName: fromName || mta.fromName || "Critsend",
    fromEmail: fromEmail || mta.fromEmail || mta.username,
    subject: personalizedSubject,
    htmlContent: personalizedHtml,
  });

  if (!result.success) {
    throw new Error(`Email send failed: ${result.error || "Unknown error"}`);
  }

  logger.info(`${logPrefix} Email sent to ${subscriber.email} (messageId: ${result.messageId})`);
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
  // updateResult.rowCount tells us whether we actually completed the row, so
  // we only bump totalCompleted in that case.
  const updateResult = await db
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
    ));

  const rowsAffected = (updateResult as any).rowCount ?? 0;
  if (rowsAffected === 0) {
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
