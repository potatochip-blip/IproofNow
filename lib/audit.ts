import { prisma } from './db';
import { logger } from './logger';

export type AuditInput = {
  actorUserId: string | null;
  entityType: string;
  entityId: string;
  action: string;
  meta?: Record<string, unknown>;
};

/**
 * Write an audit log row. Failures are logged but never thrown — audit must
 * not break the user-visible request.
 *
 * Phase 1 actions:
 *   auth.login.success | auth.login.failure | auth.logout | auth.session.expired
 *
 * Rule for later phases (recorded in CLAUDE.md): audit STATE CHANGES and
 * SENSITIVE READS (hidden vault reveals, downloads, package access, non-owner
 * case detail). Skip routine reads (dashboard, list vault, view own proof).
 */
export async function writeAudit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorUserId: input.actorUserId,
        entityType: input.entityType,
        entityId: input.entityId,
        action: input.action,
        meta: (input.meta ?? {}) as object,
      },
    });
  } catch (err) {
    logger.error('audit.write_failed', {
      err: err instanceof Error ? err.message : String(err),
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
    });
  }
}
