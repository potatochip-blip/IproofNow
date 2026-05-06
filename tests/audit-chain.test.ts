import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
import { appendAudit, computeEntryHash, writeAudit } from '@/lib/audit';
import { verifyAuditChain } from '@/lib/audit-chain';
import { GET as auditVerify } from '@/app/api/audit/verify/route';
import { createTestUser, db, loginAs, truncateAll } from './helpers';
import { resetCookieJar } from './cookie-jar';

beforeEach(async () => {
  await truncateAll();
  resetCookieJar();
});

afterAll(async () => {
  await db().$disconnect();
});

describe('audit hash chain', () => {
  it('empty chain verifies ok with count=0', async () => {
    const result = await verifyAuditChain();
    expect(result).toEqual({ ok: true, count: 0 });
  });

  it('genesis row has prevHash null and verifies', async () => {
    const { user } = await createTestUser();
    await appendAudit({
      actorUserId: user.id,
      entityType: 'User',
      entityId: user.id,
      action: 'auth.login.success',
    });

    const rows = await db().auditLog.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.prevHash).toBeNull();
    expect(rows[0]?.entryHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.signature).toMatch(/^[0-9a-f]{64}$/);

    const result = await verifyAuditChain();
    expect(result).toEqual({ ok: true, count: 1 });
  });

  it('chain links: each row references the previous entryHash', async () => {
    const { user } = await createTestUser();
    for (let i = 0; i < 5; i++) {
      await appendAudit({
        actorUserId: user.id,
        entityType: 'Proof',
        entityId: `p${i}`,
        action: 'proof.created',
      });
    }

    const rows = await db().auditLog.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(rows).toHaveLength(5);
    expect(rows[0]?.prevHash).toBeNull();
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]?.prevHash).toBe(rows[i - 1]?.entryHash);
    }

    const result = await verifyAuditChain();
    expect(result).toEqual({ ok: true, count: 5 });
  });

  it('detects tampered meta as hash_mismatch', async () => {
    const { user } = await createTestUser();
    await appendAudit({
      actorUserId: user.id,
      entityType: 'Proof',
      entityId: 'p1',
      action: 'proof.created',
      meta: { value: 'original' },
    });
    await appendAudit({
      actorUserId: user.id,
      entityType: 'Proof',
      entityId: 'p2',
      action: 'proof.created',
    });

    const target = await db().auditLog.findFirst({ where: { entityId: 'p1' } });
    expect(target).toBeTruthy();

    // Tamper directly via raw SQL — application path never updates audit
    // rows, so we go through Postgres to simulate a malicious operator.
    await db().$executeRawUnsafe(
      `UPDATE "AuditLog" SET "meta" = '{"value":"tampered"}'::jsonb WHERE "id" = $1`,
      target!.id
    );

    const result = await verifyAuditChain();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAt).toBe(target!.id);
      expect(result.reason).toBe('hash_mismatch');
    }
  });

  it('detects tampered signature as signature_mismatch', async () => {
    const { user } = await createTestUser();
    await appendAudit({
      actorUserId: user.id,
      entityType: 'Proof',
      entityId: 'p1',
      action: 'proof.created',
    });

    const target = await db().auditLog.findFirst({ where: { entityId: 'p1' } });
    // Replace signature with a syntactically valid but wrong HMAC.
    const bogus = 'a'.repeat(64);
    await db().$executeRawUnsafe(
      `UPDATE "AuditLog" SET "signature" = $1 WHERE "id" = $2`,
      bogus,
      target!.id
    );

    const result = await verifyAuditChain();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('signature_mismatch');
    }
  });

  it('detects deleted middle row as broken_link', async () => {
    const { user } = await createTestUser();
    for (let i = 0; i < 3; i++) {
      await appendAudit({
        actorUserId: user.id,
        entityType: 'Proof',
        entityId: `p${i}`,
        action: 'proof.created',
      });
    }
    const middle = await db().auditLog.findFirst({ where: { entityId: 'p1' } });
    await db().$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "id" = $1`, middle!.id);

    const result = await verifyAuditChain();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('broken_link');
    }
  });

  it('computeEntryHash is deterministic and meta-key-order-insensitive', () => {
    const createdAt = new Date('2026-05-05T12:00:00.000Z');
    const a = computeEntryHash({
      prevHash: null,
      actorUserId: 'u1',
      entityType: 'Proof',
      entityId: 'p1',
      action: 'proof.created',
      meta: { b: 2, a: 1 },
      createdAt,
    });
    const b = computeEntryHash({
      prevHash: null,
      actorUserId: 'u1',
      entityType: 'Proof',
      entityId: 'p1',
      action: 'proof.created',
      meta: { a: 1, b: 2 },
      createdAt,
    });
    expect(a).toBe(b);
  });

  it('writeAudit (passthrough) participates in the chain', async () => {
    const { user } = await createTestUser();
    await writeAudit({
      actorUserId: user.id,
      entityType: 'User',
      entityId: user.id,
      action: 'auth.login.success',
    });
    const result = await verifyAuditChain();
    expect(result).toEqual({ ok: true, count: 1 });
  });

  it('GET /api/audit/verify is admin-only and self-emits audit.chain.verified', async () => {
    const { user: regular } = await createTestUser();
    await loginAs(regular.id);
    const res403 = await auditVerify(
      new Request('http://localhost/api/audit/verify') as NextRequest
    );
    expect(res403.status).toBe(403);

    resetCookieJar();
    const { user: admin } = await createTestUser({
      email: 'admin@iproofnow.dev',
      role: 'ADMIN',
    });
    await loginAs(admin.id);
    const res = await auditVerify(
      new Request('http://localhost/api/audit/verify') as NextRequest
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const verifiedRow = await db().auditLog.findFirst({
      where: { action: 'audit.chain.verified', actorUserId: admin.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(verifiedRow).toBeTruthy();
    const meta = verifiedRow?.meta as { ok: boolean; count: number };
    expect(meta.ok).toBe(true);
    expect(typeof meta.count).toBe('number');

    // The verify endpoint's own audit row extended the chain — verify
    // again and the count should include it.
    const after = await verifyAuditChain();
    expect(after.ok).toBe(true);
  });
});
