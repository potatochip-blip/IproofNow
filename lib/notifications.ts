import { prisma } from './db';
import { logger } from './logger';

/**
 * Closed enum of notification types. Adding a new type is a deliberate
 * contract change — frontend branches on `type`, so freeform strings would
 * silently break icon / route mapping. Document additions in CLAUDE.md.
 *
 * Phase 3: 'proof_sealed'.
 * Phase 4: 'evidence_package_requested' — fired on POST
 *          /api/cases/:caseId/packages; recipient is the case owner so they
 *          know someone on their team kicked off a package build. Self-notify
 *          is intentional (mirrors proof_sealed) — owner-initiated requests
 *          still produce a notification because the package surface itself
 *          is async.
 * Phase 5: 'evidence_package_ready' — fired by the build-package worker on
 *          successful upload to S3. Recipient = case owner. Closes the loop
 *          opened by 'evidence_package_requested'. Failures emit no
 *          notification — the package row's status flips to FAILED and a
 *          retry will replay this signal once the worker succeeds.
 * Future: 'proof_verified_public', 'case_shared', ...
 */
export type NotificationType =
  | 'proof_sealed'
  | 'evidence_package_requested'
  | 'evidence_package_ready';

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
