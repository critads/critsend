import { db } from "../db";
import { sql, eq, and } from "drizzle-orm";
import { automationWorkflows, automationEnrollments, subscribers } from "@shared/schema";
import type { AutomationWorkflow, AutomationEnrollment, TriggerType } from "@shared/schema";
import { logger } from "../logger";
import { isPoolHealthy } from "../db";
import { sendTestEmailViaSMTP } from "../email-service";
import { storage } from "../storage";

interface WorkflowStep {
  type: "send_email" | "wait" | "add_tag" | "remove_tag";
  config: Record<string, string | number>;
}

const AUTOMATION_BATCH_SIZE = 50;
const AUTOMATION_LEASE_MINUTES = 5;

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
    await db
      .update(automationEnrollments)
      .set({
        currentStepIndex: nextIndex,
        nextActionAt: new Date(),
        lastError: null,
      })
      .where(eq(automationEnrollments.id, enrollment.id));
  }
}

async function executeSendEmailStep(
  enrollment: AutomationEnrollment,
  workflow: AutomationWorkflow,
  step: WorkflowStep,
  logPrefix: string
): Promise<void> {
  const { subject, fromName, fromEmail, htmlContent } = step.config as {
    subject?: string;
    fromName?: string;
    fromEmail?: string;
    htmlContent?: string;
  };

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

  const mtaId = (workflow as any).mtaId;
  if (!mtaId) {
    throw new Error("Workflow has no MTA configured for email sending");
  }

  const mta = await storage.getMta(mtaId);
  if (!mta) {
    throw new Error(`MTA ${mtaId} not found`);
  }

  const personalizedHtml = (htmlContent as string)
    .replace(/\{\{email\}\}/gi, subscriber.email)
    .replace(/\{\{name\}\}/gi, subscriber.name || subscriber.email);

  const personalizedSubject = (subject as string)
    .replace(/\{\{email\}\}/gi, subscriber.email)
    .replace(/\{\{name\}\}/gi, subscriber.name || subscriber.email);

  const result = await sendTestEmailViaSMTP(mta, {
    to: subscriber.email,
    fromName: (fromName as string) || mta.fromName || "Critsend",
    fromEmail: (fromEmail as string) || mta.fromEmail || mta.username,
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
    .where(eq(automationEnrollments.id, enrollment.id));
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
}

async function markEnrollmentCompleted(enrollment: AutomationEnrollment, workflow: AutomationWorkflow): Promise<void> {
  await db
    .update(automationEnrollments)
    .set({
      status: "completed",
      completedAt: new Date(),
      nextActionAt: null,
      lastError: null,
    })
    .where(eq(automationEnrollments.id, enrollment.id));

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
