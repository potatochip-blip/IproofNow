import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
import { POST as reveal } from '@/app/api/vault/[proofId]/reveal/route';
import {
  buildJsonRequest,
  createTestProof,
  createTestUser,
  db,
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

function ctx(proofId: string) {
  return { params: { proofId } };
}

function revealReq(proofId: string, body: unknown) {
  return buildJsonRequest(
    `http://localhost/api/vault/${proofId}/reveal`,
    'POST',
    body
  ) as NextRequest;
}

describe('POST /api/vault/[proofId]/reveal', () => {
  it('owner with valid reason: 200, returns full proof, audit row written', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);
    const proof = await createTestProof(user.id, { title: 'secret-journal' });
    await db().preservationConfig.create({
      data: { proofId: proof.id, hiddenVaultMode: true },
    });

    const res = await reveal(
      revealReq(proof.id, { reason: 'case_review' }),
      ctx(proof.id)
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.proof.id).toBe(proof.id);
    expect(body.proof.title).toBe('secret-journal');
    expect(body.proof.preservation.hiddenVaultMode).toBe(true);

    const audit = await db().auditLog.findFirst({
      where: { entityId: proof.id, action: 'proof.hidden.revealed' },
    });
    expect(audit).toBeTruthy();
    const meta = audit?.meta as { reason: string; hiddenVaultMode: boolean };
    expect(meta.reason).toBe('case_review');
    expect(meta.hiddenVaultMode).toBe(true);
  });

  it("reason='other' with reasonText is accepted and stored in audit meta", async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);
    const proof = await createTestProof(user.id);

    const res = await reveal(
      revealReq(proof.id, { reason: 'other', reasonText: 'Court discovery req 7-B' }),
      ctx(proof.id)
    );
    expect(res.status).toBe(200);

    const audit = await db().auditLog.findFirst({
      where: { entityId: proof.id, action: 'proof.hidden.revealed' },
    });
    const meta = audit?.meta as { reason: string; reasonText: string };
    expect(meta.reasonText).toBe('Court discovery req 7-B');
  });

  it("reason='other' without reasonText → 400", async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);
    const proof = await createTestProof(user.id);

    const res = await reveal(revealReq(proof.id, { reason: 'other' }), ctx(proof.id));
    expect(res.status).toBe(400);
  });

  it('missing reason → 400', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);
    const proof = await createTestProof(user.id);

    const res = await reveal(revealReq(proof.id, {}), ctx(proof.id));
    expect(res.status).toBe(400);
  });

  it('non-owner on visible proof → 403', async () => {
    const owner = await createTestUser();
    const proof = await createTestProof(owner.user.id);

    const other = await createTestUser({ email: 'other@iproofnow.dev' });
    await loginAs(other.user.id);

    const res = await reveal(
      revealReq(proof.id, { reason: 'user_browse' }),
      ctx(proof.id)
    );
    expect(res.status).toBe(403);
  });

  it('non-owner on hidden proof → 404 (existence not leaked)', async () => {
    const owner = await createTestUser();
    const proof = await createTestProof(owner.user.id);
    await db().preservationConfig.create({
      data: { proofId: proof.id, hiddenVaultMode: true },
    });

    const other = await createTestUser({ email: 'other@iproofnow.dev' });
    await loginAs(other.user.id);

    const res = await reveal(
      revealReq(proof.id, { reason: 'user_browse' }),
      ctx(proof.id)
    );
    expect(res.status).toBe(404);
  });

  it('missing proof → 404', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);

    const res = await reveal(
      revealReq('does-not-exist', { reason: 'user_browse' }),
      ctx('does-not-exist')
    );
    expect(res.status).toBe(404);
  });

  it('401 without session', async () => {
    const res = await reveal(
      revealReq('any', { reason: 'user_browse' }),
      ctx('any')
    );
    expect(res.status).toBe(401);
  });
});
