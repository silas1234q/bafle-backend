import { env } from "../env.js";
import { prisma } from "../lib/prisma.js";
import { enqueueJob } from "../jobs/queue.js";
import {
  EmailProviderError,
  emailProvider,
  renderNotification,
  type NotificationPayload,
  type NotificationType,
} from "../notifications/index.js";
import { Prisma } from "../generated/prisma/client.js";

/**
 * Notifications.
 *
 * Two layers of protection against sending twice, because a duplicate "you
 * won" email is both confusing and erodes trust in the draw:
 *
 *   Notification  — a unique (type, entityId, recipient) row. Permanent.
 *   Job.dedupeKey — stops a second job queueing while one is outstanding.
 *
 * The Job key alone is not enough: it is cleared on completion, so a replayed
 * webhook days later would happily queue the same message again.
 */

export const NOTIFICATION_JOB_TYPE = "notification.send";

type Tx = Prisma.TransactionClient;

export interface QueueNotificationInput {
  type: NotificationType;
  recipientUserId: string;
  entityType: string;
  entityId: string;
  payload?: NotificationPayload;
}

/**
 * Records and queues a notification.
 *
 * Pass the caller's transaction so the intent to notify commits with the state
 * change that caused it — a winner drawn but never told is worse than a draw
 * that rolled back entirely.
 *
 * Returns null when this exact notification was already recorded.
 */
export async function queueNotification(
  tx: Tx | typeof prisma,
  input: QueueNotificationInput,
): Promise<string | null> {
  // appUrl is captured now rather than read at send time, so a link in an
  // email never depends on config that changed afterwards.
  const payload: NotificationPayload = { appUrl: env.APP_URL, ...input.payload };

  // Quiet fast path. The catch below still handles genuine races, but
  // without this every deduped send logs a constraint violation at error
  // level and reads as a fault when it is the mechanism working.
  const existing = await tx.notification.findUnique({
    where: {
      type_entityId_recipientUserId: {
        type: input.type,
        entityId: input.entityId,
        recipientUserId: input.recipientUserId,
      },
    },
    select: { id: true },
  });
  if (existing) return null;

  let notificationId: string;
  try {
    const created = await tx.notification.create({
      data: {
        type: input.type,
        recipientUserId: input.recipientUserId,
        entityType: input.entityType,
        entityId: input.entityId,
        payload: payload as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    notificationId = created.id;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      // Already sent, or already queued. The unique index is the whole point.
      return null;
    }
    throw error;
  }

  await enqueueJob(tx, {
    type: NOTIFICATION_JOB_TYPE,
    payload: { notificationId },
    dedupeKey: `${NOTIFICATION_JOB_TYPE}:${notificationId}`,
    maxAttempts: 4,
  });

  return notificationId;
}

export interface SendNotificationResult {
  status: "sent" | "already_sent" | "skipped" | "failed";
  reason?: string;
}

/**
 * Renders and sends one notification.
 *
 * Throws on a retryable provider failure so the job runner applies backoff;
 * returns "failed" for permanent problems (bad address, unknown template)
 * where retrying would only burn attempts.
 */
export async function sendNotification(
  notificationId: string,
): Promise<SendNotificationResult> {
  const notification = await prisma.notification.findUnique({
    where: { id: notificationId },
    select: {
      id: true,
      type: true,
      status: true,
      payload: true,
      recipient: { select: { email: true, username: true, suspendedAt: true } },
    },
  });

  if (!notification) return { status: "skipped", reason: "notification_not_found" };
  if (notification.status === "SENT") return { status: "already_sent" };

  const recipient = notification.recipient;

  // Anonymised accounts get a @deleted.invalid address; mailing it would just
  // generate bounces, which hurt sender reputation.
  if (recipient.email.endsWith("@deleted.invalid")) {
    await prisma.notification.update({
      where: { id: notificationId },
      data: { status: "FAILED", failureReason: "recipient_deleted" },
    });
    return { status: "skipped", reason: "recipient_deleted" };
  }

  const rendered = renderNotification(
    notification.type,
    (notification.payload ?? {}) as NotificationPayload,
  );

  if (!rendered) {
    await prisma.notification.update({
      where: { id: notificationId },
      data: { status: "FAILED", failureReason: `no_template:${notification.type}` },
    });
    return { status: "failed", reason: "no_template" };
  }

  try {
    await emailProvider().send({
      to: recipient.email,
      toName: recipient.username,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });

    await prisma.notification.update({
      where: { id: notificationId },
      data: {
        status: "SENT",
        sentAt: new Date(),
        attempts: { increment: 1 },
        failureReason: null,
      },
    });

    return { status: "sent" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await prisma.notification.update({
      where: { id: notificationId },
      data: { attempts: { increment: 1 }, failureReason: message.slice(0, 500) },
    });

    // Retryable: rethrow so the queue backs off and tries again.
    if (error instanceof EmailProviderError && error.retryable) throw error;

    await prisma.notification.update({
      where: { id: notificationId },
      data: { status: "FAILED" },
    });
    return { status: "failed", reason: message.slice(0, 200) };
  }
}
