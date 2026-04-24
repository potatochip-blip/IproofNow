import { prisma } from './db';
import { logger } from './logger';

/**
 * Closed enum of notification types. Adding a new type is a deliberate
 * contract change — frontend branches on `type`, so freeform strings would
 * silently break icon / route mapping. Document additions in CLAUDE.md.
 *
 * Phase 3: 'proof_sealed'.
 * Future: 'proof_verified_public', 'evidence_package_ready', 'case_shared', ...
 */
export type NotificationType = 'proof_sealed';

export type CreateNotificationInput = {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  href?: string;
};

/**
 * Fire-and-log notification writer. Mirrors writeAudit()'s contract:
 * failures are logged but never thrown so they can't destabilize the
 * user-visible request that triggered them.
 */
export async function createNotification(input: CreateNotificationInput): Promise<void> {
  try {
    await prisma.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body,
        href: input.href ?? null,
      },
    });
  } catch (err) {
    logger.error('notification.write_failed', {
      err: err instanceof Error ? err.message : String(err),
      type: input.type,
      userId: input.userId,
    });
  }
}
