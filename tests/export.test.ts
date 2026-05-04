import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
import { GET as exportProof } from '@/app/api/proofs/[proofId]/export/route';
import {
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

function req(proofId: string) {
  return new Request(`http://localhost/api/proofs/${proofId}/export`) as NextRequest;
}

describe('GET /api/proofs/[proofId]/export', () => {
  it('owner: full proof + null anchor when none recorded; audits proof.exported', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);
    const proof = await createTestProof(user.id, { title: 'export-me' });

    const res = await exportProof(req(proof.id), ctx(proof.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.proof.id).toBe(proof.id);
    expect(body.proof.title).toBe('export-me');
    expect(body.anchor).toBeNull();

    const audit = await db().auditLog.findFirst({
      where: { entityId: proof.id, action: 'proof.exported' },
    });
    expect(audit).toBeTruthy();
    const meta = audit?.meta as {
      fileCount: number;
      hasAttestation: boolean;
      anchored: boolean;
    };
    expect(meta.fileCount).toBe(0);
    expect(meta.hasAttestation).toBe(false);
    expect(meta.anchored).toBe(false);
  });

  it('owner: returns the anchor block when one exists (base64-encoded otsProof)', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);
    const proof = await createTestProof(user.id);
    await db().proofAnchor.create({
      data: {
        proofId: proof.id,
        otsProof: Buffer.from('hello-anchor'),
        status: 'STUB',
      },
    });

    const res = await exportProof(req(proof.id), ctx(proof.id));
    const body = await res.json();
    expect(body.anchor.status).toBe('STUB');
    expect(typeof body.anchor.anchoredAt).toBe('string');
    // base64('hello-anchor') = aGVsbG8tYW5jaG9y
    expect(body.anchor.otsProof).toBe('aGVsbG8tYW5jaG9y');
  });

  it('hidden-vault proof: non-owner → 404 (existence not leaked)', async () => {
    const owner = await createTestUser();
    const proof = await createTestProof(owner.user.id);
    await db().preservationConfig.create({
      data: { proofId: proof.id, hiddenVaultMode: true },
    });

    const stranger = await createTestUser({ email: 'stranger@iproofnow.dev' });
    await loginAs(stranger.user.id);

    const res = await exportProof(req(proof.id), ctx(proof.id));
    expect(res.status).toBe(404);
  });

  it('foreign user, PRIVATE proof → 404', async () => {
    const owner = await createTestUser();
    const proof = await createTestProof(owner.user.id, { visibility: 'PRIVATE' });

    const stranger = await createTestUser({ email: 'stranger@iproofnow.dev' });
    await loginAs(stranger.user.id);

    const res = await exportProof(req(proof.id), ctx(proof.id));
    expect(res.status).toBe(404);
  });

  it('401 without session', async () => {
    const owner = await createTestUser();
    const proof = await createTestProof(owner.user.id);

    const res = await exportProof(req(proof.id), ctx(proof.id));
    expect(res.status).toBe(401);
  });
});
