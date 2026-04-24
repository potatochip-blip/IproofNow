import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
import {
  GET as listProofs,
  POST as createProof,
} from '@/app/api/proofs/route';
import {
  GET as getProof,
  PATCH as patchProof,
} from '@/app/api/proofs/[proofId]/route';
import {
  GET as listFiles,
  POST as uploadFile,
} from '@/app/api/proofs/[proofId]/files/route';
import { POST as upsertAttestation } from '@/app/api/proofs/[proofId]/attestation/route';
import { POST as sealProof } from '@/app/api/proofs/[proofId]/seal/route';
import { isStorageReachable } from '@/lib/storage';
import {
  buildJsonRequest,
  buildMultipartRequest,
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

// ─── helpers scoped to this file ──────────────────────────────────────────

async function asUser(opts: { role?: 'INDIVIDUAL' | 'COMPANY' | 'LAWYER' } = {}) {
  const { user } = await createTestUser({ role: opts.role ?? 'INDIVIDUAL' });
  await loginAs(user.id);
  return user;
}

function ctx(proofId: string) {
  return { params: { proofId } };
}

// ─── POST /api/proofs ─────────────────────────────────────────────────────

describe('POST /api/proofs', () => {
  it('201, owner is session user, status draft, orgId null for solo user', async () => {
    const user = await asUser();

    const res = await createProof(
      buildJsonRequest('http://localhost/api/proofs', 'POST', {
        proofType: 'document',
        categoryKey: 'contract',
        title: 'My Proof',
        description: 'A thing',
        roleContext: 'freelance',
      }) as NextRequest
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.proof.ownerUserId).toBe(user.id);
    expect(body.proof.status).toBe('draft');
    expect(body.proof.visibility).toBe('private');
    expect(body.proof.organizationId).toBeNull();
    expect(body.proof.roleContext).toBe('freelance');
    expect(body.proof.files).toEqual([]);
    expect(body.proof.attestation).toBeNull();
    expect(body.proof.preservation).toEqual({
      preservationMode: false,
      hiddenVaultMode: false,
    });

    const audit = await db().auditLog.findFirst({
      where: { actorUserId: user.id, action: 'proof.created' },
    });
    expect(audit).toBeTruthy();
  });

  it('inherits orgId from user.orgId', async () => {
    const user = await asUser({ role: 'COMPANY' });
    const org = await createTestOrg(user.id, 'Acme');
    await joinOrg(user.id, org.id);

    const res = await createProof(
      buildJsonRequest('http://localhost/api/proofs', 'POST', {
        proofType: 'document',
        categoryKey: 'contract',
        title: 'Org Proof',
      }) as NextRequest
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.proof.organizationId).toBe(org.id);
  });

  it('401 without session', async () => {
    const res = await createProof(
      buildJsonRequest('http://localhost/api/proofs', 'POST', {
        proofType: 'document',
        categoryKey: 'contract',
        title: 'x',
      }) as NextRequest
    );
    expect(res.status).toBe(401);
  });

  it('400 on missing required fields', async () => {
    await asUser();
    const res = await createProof(
      buildJsonRequest('http://localhost/api/proofs', 'POST', {
        title: 'no type, no category',
      }) as NextRequest
    );
    expect(res.status).toBe(400);
  });
});

// ─── PATCH /api/proofs/:id ────────────────────────────────────────────────

describe('PATCH /api/proofs/[proofId]', () => {
  it('owner updates metadata + preservation upserts config row', async () => {
    const user = await asUser();
    const proof = await createTestProof(user.id);

    const res = await patchProof(
      buildJsonRequest(`http://localhost/api/proofs/${proof.id}`, 'PATCH', {
        title: 'New Title',
        notes: 'new notes',
        visibility: 'ORG',
        preservationMode: true,
        hiddenVaultMode: false,
      }) as NextRequest,
      ctx(proof.id)
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.proof.title).toBe('New Title');
    expect(body.proof.notes).toBe('new notes');
    expect(body.proof.visibility).toBe('org');
    expect(body.proof.preservation).toEqual({
      preservationMode: true,
      hiddenVaultMode: false,
    });

    const audit = await db().auditLog.findFirst({
      where: { entityId: proof.id, action: 'proof.updated' },
    });
    expect(audit).toBeTruthy();
  });

  it('non-owner gets 403 when proof is visible', async () => {
    const owner = await createTestUser();
    const proof = await createTestProof(owner.user.id);

    // Switch to a different user session.
    resetCookieJar();
    const other = await createTestUser({ email: 'other@iproofnow.dev' });
    await loginAs(other.user.id);

    const res = await patchProof(
      buildJsonRequest(`http://localhost/api/proofs/${proof.id}`, 'PATCH', {
        title: 'Hacked',
      }) as NextRequest,
      ctx(proof.id)
    );

    expect(res.status).toBe(403);
  });

  it('409 when proof is already sealed', async () => {
    const user = await asUser();
    const proof = await createTestProof(user.id);
    await db().proof.update({
      where: { id: proof.id },
      data: { status: 'SEALED', sealedAt: new Date() },
    });

    const res = await patchProof(
      buildJsonRequest(`http://localhost/api/proofs/${proof.id}`, 'PATCH', {
        title: 'too late',
      }) as NextRequest,
      ctx(proof.id)
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('CONFLICT');
  });
});

// ─── GET list + detail + hidden-vault ─────────────────────────────────────

describe('GET /api/proofs (list)', () => {
  it('default scope: own + same-org non-private; hidden excluded', async () => {
    const user = await asUser({ role: 'COMPANY' });
    const org = await createTestOrg(user.id, 'CoOrg');
    await joinOrg(user.id, org.id);

    // caller's own non-org proof
    await createTestProof(user.id, { title: 'own solo' });
    // caller's own org proof, private (still in own-scope)
    await createTestProof(user.id, { title: 'own org private', orgId: org.id });
    // org-mate's org proof, ORG-visible — should appear
    const mate = await createTestUser({ email: 'mate@iproofnow.dev', role: 'COMPANY' });
    await joinOrg(mate.user.id, org.id);
    await createTestProof(mate.user.id, {
      title: 'mate org-visible',
      orgId: org.id,
      visibility: 'ORG',
    });
    // org-mate's org proof, PRIVATE — should NOT appear for the caller
    await createTestProof(mate.user.id, {
      title: 'mate private',
      orgId: org.id,
      visibility: 'PRIVATE',
    });
    // caller's hidden proof — should NOT appear in default scope
    const hidden = await createTestProof(user.id, { title: 'hidden' });
    await db().preservationConfig.create({
      data: { proofId: hidden.id, hiddenVaultMode: true },
    });

    const res = await listProofs(
      new Request('http://localhost/api/proofs') as NextRequest
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const titles = body.proofs.map((p: { title: string }) => p.title).sort();
    expect(titles).toEqual(['mate org-visible', 'own org private', 'own solo']);
  });

  it('?scope=hidden returns owner hidden proofs only + audits', async () => {
    const user = await asUser();
    const normal = await createTestProof(user.id, { title: 'normal' });
    const hidden = await createTestProof(user.id, { title: 'secret' });
    await db().preservationConfig.create({
      data: { proofId: hidden.id, hiddenVaultMode: true },
    });
    void normal;

    const res = await listProofs(
      new Request('http://localhost/api/proofs?scope=hidden') as NextRequest
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.proofs).toHaveLength(1);
    expect(body.proofs[0].title).toBe('secret');

    const audit = await db().auditLog.findFirst({
      where: { actorUserId: user.id, action: 'proof.hidden.listed' },
    });
    expect(audit).toBeTruthy();
  });

  it('status + category filters compose', async () => {
    const user = await asUser();
    await createTestProof(user.id, { title: 'a', categoryKey: 'contract' });
    const b = await createTestProof(user.id, { title: 'b', categoryKey: 'contract' });
    await db().proof.update({
      where: { id: b.id },
      data: { status: 'SEALED', sealedAt: new Date() },
    });
    await createTestProof(user.id, { title: 'c', categoryKey: 'photo' });

    const res = await listProofs(
      new Request(
        'http://localhost/api/proofs?status=SEALED&category=contract'
      ) as NextRequest
    );
    const body = await res.json();
    expect(body.proofs).toHaveLength(1);
    expect(body.proofs[0].title).toBe('b');
  });
});

describe('GET /api/proofs/[proofId] (detail)', () => {
  it('returns full detail for owner', async () => {
    const user = await asUser();
    const proof = await createTestProof(user.id);
    const res = await getProof(
      new Request(`http://localhost/api/proofs/${proof.id}`) as NextRequest,
      ctx(proof.id)
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.proof.id).toBe(proof.id);
  });

  it('hidden-vault proof returns 404 to non-owner', async () => {
    const owner = await createTestUser();
    const proof = await createTestProof(owner.user.id);
    await db().preservationConfig.create({
      data: { proofId: proof.id, hiddenVaultMode: true },
    });

    const other = await createTestUser({ email: 'other@iproofnow.dev' });
    await loginAs(other.user.id);

    const res = await getProof(
      new Request(`http://localhost/api/proofs/${proof.id}`) as NextRequest,
      ctx(proof.id)
    );
    expect(res.status).toBe(404);
  });

  it('hidden-vault proof returns 200 to owner', async () => {
    const user = await asUser();
    const proof = await createTestProof(user.id);
    await db().preservationConfig.create({
      data: { proofId: proof.id, hiddenVaultMode: true },
    });

    const res = await getProof(
      new Request(`http://localhost/api/proofs/${proof.id}`) as NextRequest,
      ctx(proof.id)
    );
    expect(res.status).toBe(200);
  });

  it('non-owner org-mate gets 404 on PRIVATE proof (not leaked as 403)', async () => {
    const owner = await createTestUser({ role: 'COMPANY' });
    const org = await createTestOrg(owner.user.id);
    await joinOrg(owner.user.id, org.id);
    const proof = await createTestProof(owner.user.id, {
      orgId: org.id,
      visibility: 'PRIVATE',
    });

    const mate = await createTestUser({ email: 'mate@iproofnow.dev', role: 'COMPANY' });
    await joinOrg(mate.user.id, org.id);
    await loginAs(mate.user.id);

    const res = await getProof(
      new Request(`http://localhost/api/proofs/${proof.id}`) as NextRequest,
      ctx(proof.id)
    );
    expect(res.status).toBe(404);
  });
});

// ─── Files (MinIO-gated) ──────────────────────────────────────────────────

describe('POST + GET /api/proofs/[proofId]/files (MinIO-gated)', () => {
  it('uploads bytes, row exists, presigned downloadUrl serves them back', async (t) => {
    if (!(await isStorageReachable())) {
      t.skip();
      return;
    }
    const user = await asUser();
    const proof = await createTestProof(user.id);
    const bytes = new TextEncoder().encode('hello world');

    const res = await uploadFile(
      buildMultipartRequest(
        `http://localhost/api/proofs/${proof.id}/files`,
        bytes,
        'hello.txt',
        'text/plain'
      ) as NextRequest,
      ctx(proof.id)
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.file.originalName).toBe('hello.txt');
    expect(body.file.mimeType).toBe('text/plain');
    expect(body.file.size).toBe(bytes.byteLength);
    expect(body.file.hashStatus).toBe('pending');
    expect(body.file.fileHash).toBeNull();
    expect(body.file.downloadUrl).toMatch(/^https?:\/\//);

    // Presigned URL round-trips.
    const fetched = await fetch(body.file.downloadUrl);
    expect(fetched.status).toBe(200);
    const text = await fetched.text();
    expect(text).toBe('hello world');

    const audit = await db().auditLog.findFirst({
      where: { entityId: proof.id, action: 'proof.file.uploaded' },
    });
    expect(audit).toBeTruthy();
  });

  it('409 when proof is sealed', async () => {
    const user = await asUser();
    const proof = await createTestProof(user.id);
    await db().proof.update({
      where: { id: proof.id },
      data: { status: 'SEALED', sealedAt: new Date() },
    });

    const res = await uploadFile(
      buildMultipartRequest(
        `http://localhost/api/proofs/${proof.id}/files`,
        new TextEncoder().encode('x'),
        'x.txt',
        'text/plain'
      ) as NextRequest,
      ctx(proof.id)
    );
    expect(res.status).toBe(409);
  });

  it('rejects disallowed mime types', async () => {
    const user = await asUser();
    const proof = await createTestProof(user.id);
    const res = await uploadFile(
      buildMultipartRequest(
        `http://localhost/api/proofs/${proof.id}/files`,
        new TextEncoder().encode('<html/>'),
        'evil.html',
        'text/html'
      ) as NextRequest,
      ctx(proof.id)
    );
    expect(res.status).toBe(400);
  });
});

// ─── Attestation ──────────────────────────────────────────────────────────

describe('POST /api/proofs/[proofId]/attestation', () => {
  it('creates on first call, updates on second (upsert)', async () => {
    const user = await asUser();
    const proof = await createTestProof(user.id);

    const first = await upsertAttestation(
      buildJsonRequest(
        `http://localhost/api/proofs/${proof.id}/attestation`,
        'POST',
        {
          attestationName: 'Alice',
          attestationLocation: 'NYC',
          attestationText: 'I attest.',
        }
      ) as NextRequest,
      ctx(proof.id)
    );
    expect(first.status).toBe(200);
    const firstBody = await first.json();

    const second = await upsertAttestation(
      buildJsonRequest(
        `http://localhost/api/proofs/${proof.id}/attestation`,
        'POST',
        {
          attestationName: 'Alice',
          attestationLocation: 'NYC',
          attestationText: 'Updated statement.',
        }
      ) as NextRequest,
      ctx(proof.id)
    );
    expect(second.status).toBe(200);
    const secondBody = await second.json();

    expect(secondBody.attestation.id).toBe(firstBody.attestation.id);
    expect(secondBody.attestation.attestationText).toBe('Updated statement.');

    const rows = await db().proofAttestation.findMany({ where: { proofId: proof.id } });
    expect(rows).toHaveLength(1);
  });

  it('409 when sealed', async () => {
    const user = await asUser();
    const proof = await createTestProof(user.id);
    await db().proof.update({
      where: { id: proof.id },
      data: { status: 'SEALED', sealedAt: new Date() },
    });

    const res = await upsertAttestation(
      buildJsonRequest(
        `http://localhost/api/proofs/${proof.id}/attestation`,
        'POST',
        {
          attestationName: 'A',
          attestationLocation: 'B',
          attestationText: 'C',
        }
      ) as NextRequest,
      ctx(proof.id)
    );
    expect(res.status).toBe(409);
  });
});

// ─── Seal ─────────────────────────────────────────────────────────────────

describe('POST /api/proofs/[proofId]/seal', () => {
  it('accumulates ALL blockers in details.reasons', async () => {
    const user = await asUser();
    // Proof with empty title AND no file AND no attestation.
    const proof = await db().proof.create({
      data: {
        ownerUserId: user.id,
        title: '   ',
        description: '',
        categoryKey: 'contract',
        proofType: 'document',
      },
    });

    const res = await sealProof(
      new Request(`http://localhost/api/proofs/${proof.id}/seal`, {
        method: 'POST',
      }) as NextRequest,
      ctx(proof.id)
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('SEAL_REQUIREMENTS_NOT_MET');
    expect(body.error.details.reasons).toEqual(
      expect.arrayContaining(['missing_title', 'missing_file', 'missing_attestation'])
    );
    expect(body.error.details.reasons).toHaveLength(3);
  });

  it('happy path: seals proof, stamps sealedAt, all further writes 409', async () => {
    const user = await asUser();
    const proof = await createTestProof(user.id, { title: 'Ready' });
    // Satisfy the two prerequisites without using the upload endpoint
    // so this test runs even when MinIO isn't reachable.
    await db().proofFile.create({
      data: {
        proofId: proof.id,
        originalName: 'x.txt',
        mimeType: 'text/plain',
        size: 3,
        storagePath: `proofs/${proof.id}/manual`,
      },
    });
    await db().proofAttestation.create({
      data: {
        proofId: proof.id,
        attestationName: 'A',
        attestationLocation: 'B',
        attestationText: 'C',
      },
    });

    const res = await sealProof(
      new Request(`http://localhost/api/proofs/${proof.id}/seal`, {
        method: 'POST',
      }) as NextRequest,
      ctx(proof.id)
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.proofId).toBe(proof.id);
    expect(body.status).toBe('sealed');
    expect(body.sealedAt).toBeTruthy();

    // Second seal returns already_sealed.
    const again = await sealProof(
      new Request(`http://localhost/api/proofs/${proof.id}/seal`, {
        method: 'POST',
      }) as NextRequest,
      ctx(proof.id)
    );
    expect(again.status).toBe(409);
    const againBody = await again.json();
    expect(againBody.error.details.reasons).toContain('already_sealed');

    // PATCH on sealed proof → 409
    const patchRes = await patchProof(
      buildJsonRequest(`http://localhost/api/proofs/${proof.id}`, 'PATCH', {
        title: 'nope',
      }) as NextRequest,
      ctx(proof.id)
    );
    expect(patchRes.status).toBe(409);

    // Audit
    const sealedAudit = await db().auditLog.findFirst({
      where: { entityId: proof.id, action: 'proof.sealed' },
    });
    expect(sealedAudit).toBeTruthy();
  });
});
