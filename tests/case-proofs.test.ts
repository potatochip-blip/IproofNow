import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
import { POST as linkProofs } from '@/app/api/cases/[caseId]/proofs/route';
import { DELETE as unlinkProof } from '@/app/api/cases/[caseId]/proofs/[proofId]/route';
import {
  buildJsonRequest,
  createTestCase,
  createTestProof,
  createTestUser,
  db,
  linkCaseProof,
  loginAs,
  truncateAll,
} from './helpers';
import { resetCookieJar } from './cookie-jar';

beforeEach(async () => {
  await truncateAll();
  resetCookieJar();
});

afterAll(async () => {
  await db().$disconnect();
});

describe('POST /api/cases/:caseId/proofs (link)', () => {
  it('owner links proofs they own; audits per added proof; returns linked count', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);
    const c = await createTestCase(user.id);
    const p1 = await createTestProof(user.id);
    const p2 = await createTestProof(user.id);

    const res = await linkProofs(
      buildJsonRequest(
        `http://localhost/api/cases/${c.id}/proofs`,
        'POST',
        { proofIds: [p1.id, p2.id] }
      ) as NextRequest,
      { params: { caseId: c.id } }
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.linked).toBe(2);

    const links = await db().caseProof.findMany({ where: { caseId: c.id } });
    expect(links).toHaveLength(2);

    const audits = await db().auditLog.findMany({
      where: { entityId: c.id, action: 'case.proof.linked' },
    });
    expect(audits).toHaveLength(2);
  });

  it('atomicity: one foreign proof rolls back the entire batch', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);
    const c = await createTestCase(user.id);
    const mine = await createTestProof(user.id);

    const stranger = await createTestUser({ email: 'stranger@iproofnow.dev' });
    const theirs = await createTestProof(stranger.user.id);

    const res = await linkProofs(
      buildJsonRequest(
        `http://localhost/api/cases/${c.id}/proofs`,
        'POST',
        { proofIds: [mine.id, theirs.id] }
      ) as NextRequest,
      { params: { caseId: c.id } }
    );
    expect(res.status).toBe(403);

    // Neither link survived; no audit rows.
    const links = await db().caseProof.findMany({ where: { caseId: c.id } });
    expect(links).toEqual([]);
    const audits = await db().auditLog.findMany({
      where: { entityId: c.id, action: 'case.proof.linked' },
    });
    expect(audits).toEqual([]);
  });

  it('atomicity: missing proof id rolls back the entire batch', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);
    const c = await createTestCase(user.id);
    const mine = await createTestProof(user.id);

    const res = await linkProofs(
      buildJsonRequest(
        `http://localhost/api/cases/${c.id}/proofs`,
        'POST',
        { proofIds: [mine.id, 'does-not-exist'] }
      ) as NextRequest,
      { params: { caseId: c.id } }
    );
    expect(res.status).toBe(403);

    const links = await db().caseProof.findMany({ where: { caseId: c.id } });
    expect(links).toEqual([]);
  });

  it('idempotent re-link: only newly-created links count + audit', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);
    const c = await createTestCase(user.id);
    const p1 = await createTestProof(user.id);
    const p2 = await createTestProof(user.id);
    await linkCaseProof(c.id, p1.id);

    const res = await linkProofs(
      buildJsonRequest(
        `http://localhost/api/cases/${c.id}/proofs`,
        'POST',
        { proofIds: [p1.id, p2.id] }
      ) as NextRequest,
      { params: { caseId: c.id } }
    );
    const body = await res.json();
    expect(body.linked).toBe(1);

    const audits = await db().auditLog.findMany({
      where: { entityId: c.id, action: 'case.proof.linked' },
    });
    expect(audits).toHaveLength(1);
    const meta = audits[0]?.meta as { proofId: string };
    expect(meta.proofId).toBe(p2.id);
  });

  it('non-owner of case → 403', async () => {
    const owner = await createTestUser();
    const c = await createTestCase(owner.user.id);
    const p = await createTestProof(owner.user.id);

    const stranger = await createTestUser({ email: 'stranger@iproofnow.dev' });
    await loginAs(stranger.user.id);

    const res = await linkProofs(
      buildJsonRequest(
        `http://localhost/api/cases/${c.id}/proofs`,
        'POST',
        { proofIds: [p.id] }
      ) as NextRequest,
      { params: { caseId: c.id } }
    );
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/cases/:caseId/proofs/:proofId (unlink)', () => {
  it('owner unlinks; 204 + audit case.proof.unlinked', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);
    const c = await createTestCase(user.id);
    const p = await createTestProof(user.id);
    await linkCaseProof(c.id, p.id);

    const res = await unlinkProof(
      new Request(`http://localhost/api/cases/${c.id}/proofs/${p.id}`, {
        method: 'DELETE',
      }) as NextRequest,
      { params: { caseId: c.id, proofId: p.id } }
    );
    expect(res.status).toBe(204);

    const links = await db().caseProof.findMany({ where: { caseId: c.id } });
    expect(links).toEqual([]);
    const audit = await db().auditLog.findFirst({
      where: { entityId: c.id, action: 'case.proof.unlinked' },
    });
    expect(audit).toBeTruthy();
  });

  it('missing link → 404', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);
    const c = await createTestCase(user.id);
    const p = await createTestProof(user.id);
    // intentionally not linked

    const res = await unlinkProof(
      new Request(`http://localhost/api/cases/${c.id}/proofs/${p.id}`, {
        method: 'DELETE',
      }) as NextRequest,
      { params: { caseId: c.id, proofId: p.id } }
    );
    expect(res.status).toBe(404);
  });

  it('non-owner → 403', async () => {
    const owner = await createTestUser();
    const c = await createTestCase(owner.user.id);
    const p = await createTestProof(owner.user.id);
    await linkCaseProof(c.id, p.id);

    const stranger = await createTestUser({ email: 'stranger@iproofnow.dev' });
    await loginAs(stranger.user.id);

    const res = await unlinkProof(
      new Request(`http://localhost/api/cases/${c.id}/proofs/${p.id}`, {
        method: 'DELETE',
      }) as NextRequest,
      { params: { caseId: c.id, proofId: p.id } }
    );
    expect(res.status).toBe(403);
  });
});
