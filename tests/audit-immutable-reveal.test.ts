import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { appendAudit } from '@/lib/audit';
import { createTestUser, db, truncateAll } from './helpers';

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db().$disconnect();
});

/**
 * Phase 6: a BEFORE UPDATE trigger on AuditLog rejects modifications to
 * `proof.hidden.revealed` rows when (now() - createdAt) < 24 hours. Tests
 * verify the boundary on both sides via raw SQL UPDATEs (the application
 * path never updates audit rows, so we go through Postgres directly).
 */
describe('AuditLog immutability trigger for proof.hidden.revealed', () => {
  it('rejects UPDATE of a recent proof.hidden.revealed row', async () => {
    const { user } = await createTestUser();
    await appendAudit({
      actorUserId: user.id,
      entityType: 'Proof',
      entityId: 'p1',
      action: 'proof.hidden.revealed',
      meta: { reason: 'case_review', hiddenVaultMode: true },
    });
    const row = await db().auditLog.findFirstOrThrow({
      where: { action: 'proof.hidden.revealed' },
    });

    // createdAt = NOW() (just inserted), well within the 24h window.
    await expect(
      db().$executeRawUnsafe(
        `UPDATE "AuditLog" SET "meta" = '{"tampered":true}'::jsonb WHERE "id" = $1`,
        row.id
      )
    ).rejects.toThrow(/immutable/i);
  });

  it('allows UPDATE of an old proof.hidden.revealed row (outside 24h)', async () => {
    const { user } = await createTestUser();
    await appendAudit({
      actorUserId: user.id,
      entityType: 'Proof',
      entityId: 'p1',
      action: 'proof.hidden.revealed',
      meta: { reason: 'export_prep' },
    });
    const row = await db().auditLog.findFirstOrThrow({
      where: { action: 'proof.hidden.revealed' },
    });

    // Backdate via raw SQL so the trigger's window check sees an old row.
    // The trigger uses OLD."createdAt" (the value before this UPDATE), so
    // even the backdating UPDATE itself would trip the trigger. Suppress
    // non-RI triggers via session_replication_role inside a transaction
    // scope. Same pattern the backfill script uses for legacy reveal rows.
    await db().$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      await tx.$executeRawUnsafe(
        `UPDATE "AuditLog" SET "createdAt" = NOW() - INTERVAL '25 hours' WHERE "id" = $1`,
        row.id
      );
    });

    // Now the row's createdAt is 25h ago; the trigger should allow updates.
    await expect(
      db().$executeRawUnsafe(
        `UPDATE "AuditLog" SET "meta" = '{"forensic_export":true}'::jsonb WHERE "id" = $1`,
        row.id
      )
    ).resolves.not.toThrow();

    const refreshed = await db().auditLog.findUniqueOrThrow({ where: { id: row.id } });
    expect(refreshed.meta).toMatchObject({ forensic_export: true });
  });

  it('does not block UPDATE of unrelated audit actions', async () => {
    const { user } = await createTestUser();
    await appendAudit({
      actorUserId: user.id,
      entityType: 'User',
      entityId: user.id,
      action: 'auth.login.success',
    });
    const row = await db().auditLog.findFirstOrThrow({
      where: { action: 'auth.login.success' },
    });

    // The trigger only fires for proof.hidden.revealed; other actions can
    // be updated freely (though we never do so in production).
    await expect(
      db().$executeRawUnsafe(
        `UPDATE "AuditLog" SET "meta" = '{"note":"benign"}'::jsonb WHERE "id" = $1`,
        row.id
      )
    ).resolves.not.toThrow();
  });
});
