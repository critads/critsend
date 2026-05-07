import { db } from "../db";
import { sql, eq, and, lte, inArray } from "drizzle-orm";
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

let isProcessing = false;

export async function processAutomationEnrollments(): Promise<number> {
  if (isProcessing) return 0;
  if (!isPoolHealthy()) return 0;

  isProcessing = true;
  let processed = 0;

  try {
    const dueEnrollments = await db
      .select({
        enrollment: automationEnrollments,
        workflow: automationWorkflows,
      })
      .from(automationEnrollments)
      .innerJoin(automationWorkflows, eq(automationEnrollments.workflowId, automationWorkflows.id))
      .where(
        and(
          eq(automationEnrollments.status, "active"),
          eq(automationWorkflows.status, "active"),
          lte(automationEnrollments.nextActionAt, new Date())
        )
      )
      .limit(AUTOMATION_BATCH_SIZE);

    for (const { enrollment, workflow } of dueEnrollments) {
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
  } finally {
    isProcessing = false;
  }

  return processed;
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
        await db
          .insert(automationEnrollments)
          .values({
            workflowId: workflow.id,
            subscriberId,
            status: "active",
            nextActionAt: new Date(),
          })
          .onConflictDoNothing();

        const result = await db.execute(sql`
          SELECT id FROM automation_enrollments
          WHERE workflow_id = ${workflow.id}
            AND subscriber_id = ${subscriberId}
            AND status = 'active'
            AND current_step_index = 0
            AND enrolled_at > NOW() - INTERVAL '5 seconds'
        `);

        if (result.rows.length > 0) {
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
