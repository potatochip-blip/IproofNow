import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
import { GET as vaultList } from '@/app/api/vault/route';
import {
  createTestOrg,
  createTestProof,
  createTestUser,
  db,
  joinOrg,
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

async function asUser(opts: { role?: 'INDIVIDUAL' | 'COMPANY' } = {}) {
  const { user } = await createTestUser({ role: opts.role ?? 'INDIVIDUAL' });
  await loginAs(user.id);
  return user;
}

function vaultReq(qs = '') {
  return new Request(`http://localhost/api/vault${qs}`) as NextRequest;
}

describe('GET /api/vault', () => {
  it('owner-scoped: excludes org-mate proofs even when org-visible', async () => {
    const user = await asUser({ role: 'COMPANY' });
    const org = await createTestOrg(user.id);
    await joinOrg(user.id, org.id);
    await createTestProof(user.id, { title: 'mine', orgId: org.id });

    // Org-mate's ORG-visible proof would show up under /api/proofs, but
    // vault is deliberately owner-only — it must not appear here.
    const mate = await createTestUser({ email: 'mate@iproofnow.dev', role: 'COMPANY' });
    await joinOrg(mate.user.id, org.id);
    await createTestProof(mate.user.id, {
      title: 'theirs',
      orgId: org.id,
      visibility: 'ORG',
    });

    const res = await vaultList(vaultReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    const titles = body.proofs.map((p: { title: string }) => p.title);
    expect(titles).toEqual(['mine']);
  });

  it('default scope excludes hidden; ?scope=hidden includes only hidden', async () => {
    const user = await asUser();
    await createTestProof(user.id, { title: 'visible' });
    const hidden = await createTestProof(user.id, { title: 'hidden-one' });
    await db().preservationConfig.create({
      data: { proofId: hidden.id, hiddenVaultMode: true },
    });

    const def = await vaultList(vaultReq());
    const defBody = await def.json();
    expect(defBody.proofs.map((p: { title: string }) => p.title)).toEqual(['visible']);

    const hiddenRes = await vaultList(vaultReq('?scope=hidden'));
    const hiddenBody = await hiddenRes.json();
    expect(hiddenBody.proofs.map((p: { title: string }) => p.title)).toEqual(['hidden-one']);

    const audit = await db().auditLog.findFirst({
      where: { actorUserId: user.id, action: 'proof.hidden.listed' },
    });
    expect(audit).toBeTruthy();
  });

  it('q matches title, description, and peopleInvolved tag', async () => {
    const user = await asUser();
    await createTestProof(user.id, { title: 'Contract with Alice' });
    await createTestProof(user.id, { title: 'other', description: 'mentions Alice somewhere' });
    await createTestProof(user.id, { title: 'third', peopleInvolved: ['Alice'] });
    await createTestProof(user.id, { title: 'unrelated' });

    const res = await vaultList(vaultReq('?q=Alice'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.proofs).toHaveLength(3);
    const titles = body.proofs.map((p: { title: string }) => p.title).sort();
    expect(titles).toEqual(['Contract with Alice', 'other', 'third']);
  });

  it('status + category filters compose with q', async () => {
    const user = await asUser();
    const a = await createTestProof(user.id, { title: 'Alpha report', categoryKey: 'contract' });
    await db().proof.update({
      where: { id: a.id },
      data: { status: 'SEALED', sealedAt: new Date() },
    });
    await createTestProof(user.id, { title: 'Alpha draft', categoryKey: 'contract' });
    await createTestProof(user.id, { title: 'Alpha photo', categoryKey: 'photo' });

    const res = await vaultList(vaultReq('?q=Alpha&status=SEALED&category=contract'));
    const body = await res.json();
    expect(body.proofs).toHaveLength(1);
    expect(body.proofs[0].title).toBe('Alpha report');
  });

  it('sort composes: sortBy=title sortDir=asc', async () => {
    const user = await asUser();
    await createTestProof(user.id, { title: 'charlie' });
    await createTestProof(user.id, { title: 'alpha' });
    await createTestProof(user.id, { title: 'bravo' });

    const res = await vaultList(vaultReq('?sortBy=title&sortDir=asc'));
    const body = await res.json();
    expect(body.proofs.map((p: { title: string }) => p.title)).toEqual([
      'alpha',
      'bravo',
      'charlie',
    ]);
  });

  it('hasFiles / hasAttestation reflect reality', async () => {
    const user = await asUser();
    const bare = await createTestProof(user.id, { title: 'bare' });
    const withFile = await createTestProof(user.id, { title: 'with-file' });
    const withAtt = await createTestProof(user.id, { title: 'with-att' });
    const both = await createTestProof(user.id, { title: 'both' });

    await db().proofFile.create({
      data: {
        proofId: withFile.id,
        originalName: 'x.txt',
        mimeType: 'text/plain',
        size: 1,
        storagePath: `proofs/${withFile.id}/x`,
      },
    });
    await db().proofAttestation.create({
      data: {
        proofId: withAtt.id,
        attestationName: 'A',
        attestationLocation: 'B',
        attestationText: 'C',
      },
    });
    await db().proofFile.create({
      data: {
        proofId: both.id,
        originalName: 'y.txt',
        mimeType: 'text/plain',
        size: 1,
        storagePath: `proofs/${both.id}/y`,
      },
    });
    await db().proofAttestation.create({
      data: {
        proofId: both.id,
        attestationName: 'A',
        attestationLocation: 'B',
        attestationText: 'C',
      },
    });

    const res = await vaultList(vaultReq('?sortBy=title&sortDir=asc'));
    const body = await res.json();
    type Row = { title: string; hasFiles: boolean; hasAttestation: boolean };
    const map = Object.fromEntries(
      body.proofs.map((p: Row) => [p.title, { f: p.hasFiles, a: p.hasAttestation }])
    );
    expect(map['bare']).toEqual({ f: false, a: false });
    expect(map['with-file']).toEqual({ f: true, a: false });
    expect(map['with-att']).toEqual({ f: false, a: true });
    expect(map['both']).toEqual({ f: true, a: true });
  });

  it('401 without session', async () => {
    const res = await vaultList(vaultReq());
    expect(res.status).toBe(401);
  });
});
