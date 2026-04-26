import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
import { GET as listCases, POST as createCase } from '@/app/api/cases/route';
import { GET as getCase, PATCH as patchCase } from '@/app/api/cases/[caseId]/route';
import {
  buildJsonRequest,
  createTestCase,
  createTestOrg,
  createTestProof,
  createTestUser,
  db,
  joinOrg,
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

function casesReq(qs = '') {
  return new Request(`http://localhost/api/cases${qs}`) as NextRequest;
}

function caseReq(caseId: string) {
  return new Request(`http://localhost/api/cases/${caseId}`) as NextRequest;
}

describe('POST /api/cases', () => {
  it('creates a case, inheriting orgId from caller, and audits case.created', async () => {
    const { user } = await createTestUser({ role: 'COMPANY' });
    const org = await createTestOrg(user.id);
    await joinOrg(user.id, org.id);
    await loginAs(user.id);

    const res = await createCase(
      buildJsonRequest('http://localhost/api/cases', 'POST', {
        title: 'Acme v Beta',
        description: 'breach of contract',
      }) as NextRequest
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.case.title).toBe('Acme v Beta');
    expect(body.case.organizationId).toBe(org.id);
    expect(body.case.ownerUserId).toBe(user.id);

    const audit = await db().auditLog.findFirst({
      where: { entityId: body.case.id, action: 'case.created' },
    });
    expect(audit).toBeTruthy();
  });

  it('401 without session', async () => {
    const res = await createCase(
      buildJsonRequest('http://localhost/api/cases', 'POST', {
        title: 'No session',
      }) as NextRequest
    );
    expect(res.status).toBe(401);
  });

  it('rejects empty title', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);
    const res = await createCase(
      buildJsonRequest('http://localhost/api/cases', 'POST', { title: '' }) as NextRequest
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /api/cases', () => {
  it('default scope: own + same-org cases; foreign org cases excluded', async () => {
    const { user } = await createTestUser({ role: 'COMPANY' });
    const org = await createTestOrg(user.id);
    await joinOrg(user.id, org.id);
    await loginAs(user.id);

    await createTestCase(user.id, { title: 'mine', orgId: org.id });

    const peer = await createTestUser({ email: 'peer@iproofnow.dev', role: 'COMPANY' });
    await joinOrg(peer.user.id, org.id);
    await createTestCase(peer.user.id, { title: 'peers', orgId: org.id });

    // Foreign user's case in a different org — must NOT appear.
    const stranger = await createTestUser({ email: 'stranger@iproofnow.dev' });
    const otherOrg = await createTestOrg(stranger.user.id, 'Other Org');
    await joinOrg(stranger.user.id, otherOrg.id);
    await createTestCase(stranger.user.id, { title: 'theirs', orgId: otherOrg.id });

    const res = await listCases(casesReq());
    const body = await res.json();
    const titles = body.cases.map((c: { title: string }) => c.title).sort();
    expect(titles).toEqual(['mine', 'peers']);
  });

  it('?scope=owned narrows to caller', async () => {
    const { user } = await createTestUser({ role: 'COMPANY' });
    const org = await createTestOrg(user.id);
    await joinOrg(user.id, org.id);
    await loginAs(user.id);

    await createTestCase(user.id, { title: 'mine', orgId: org.id });
    const peer = await createTestUser({ email: 'peer@iproofnow.dev', role: 'COMPANY' });
    await joinOrg(peer.user.id, org.id);
    await createTestCase(peer.user.id, { title: 'peers', orgId: org.id });

    const res = await listCases(casesReq('?scope=owned'));
    const body = await res.json();
    expect(body.cases.map((c: { title: string }) => c.title)).toEqual(['mine']);
  });

  it('?scope=org with no org returns empty page (no false matches)', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);
    await createTestCase(user.id, { title: 'mine' });

    const res = await listCases(casesReq('?scope=org'));
    const body = await res.json();
    expect(body.cases).toEqual([]);
    expect(body.pagination.total).toBe(0);
  });

  it('q filters via title + description; status composes', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);
    await createTestCase(user.id, { title: 'Alpha', status: 'active' });
    await createTestCase(user.id, {
      title: 'Beta',
      description: 'mentions Alpha',
      status: 'archived',
    });
    await createTestCase(user.id, { title: 'Gamma', status: 'archived' });

    const both = await listCases(casesReq('?q=Alpha'));
    const bothBody = await both.json();
    expect(
      bothBody.cases.map((c: { title: string }) => c.title).sort()
    ).toEqual(['Alpha', 'Beta']);

    const alphaActive = await listCases(casesReq('?q=Alpha&status=active'));
    const alphaActiveBody = await alphaActive.json();
    expect(alphaActiveBody.cases.map((c: { title: string }) => c.title)).toEqual([
      'Alpha',
    ]);
  });

  it('counts linkedProofCount and packageCount', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);
    const c = await createTestCase(user.id, { title: 'C' });
    const p1 = await createTestProof(user.id);
    const p2 = await createTestProof(user.id);
    await linkCaseProof(c.id, p1.id);
    await linkCaseProof(c.id, p2.id);
    await db().evidencePackage.create({
      data: { caseId: c.id, packageType: 'court_bundle', createdByUserId: user.id },
    });

    const res = await listCases(casesReq());
    const body = await res.json();
    expect(body.cases[0].linkedProofCount).toBe(2);
    expect(body.cases[0].packageCount).toBe(1);
  });
});

describe('GET /api/cases/:caseId', () => {
  it('owner sees every linked proof, including PRIVATE', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);
    const c = await createTestCase(user.id);
    const priv = await createTestProof(user.id, {
      title: 'priv',
      visibility: 'PRIVATE',
    });
    const pub = await createTestProof(user.id, {
      title: 'pub',
      visibility: 'PUBLIC',
    });
    await linkCaseProof(c.id, priv.id);
    await linkCaseProof(c.id, pub.id);

    const res = await getCase(caseReq(c.id), { params: { caseId: c.id } });
    const body = await res.json();
    expect(body.case.id).toBe(c.id);
    const titles = body.proofs.map((p: { title: string }) => p.title).sort();
    expect(titles).toEqual(['priv', 'pub']);
  });

  it('same-org peer sees non-PRIVATE only; PRIVATE linked proofs hidden', async () => {
    const owner = await createTestUser({ role: 'COMPANY' });
    const org = await createTestOrg(owner.user.id);
    await joinOrg(owner.user.id, org.id);
    const c = await createTestCase(owner.user.id, { orgId: org.id });

    const priv = await createTestProof(owner.user.id, {
      title: 'priv',
      orgId: org.id,
      visibility: 'PRIVATE',
    });
    const orgVis = await createTestProof(owner.user.id, {
      title: 'orgVis',
      orgId: org.id,
      visibility: 'ORG',
    });
    await linkCaseProof(c.id, priv.id);
    await linkCaseProof(c.id, orgVis.id);

    const peer = await createTestUser({ email: 'peer@iproofnow.dev', role: 'COMPANY' });
    await joinOrg(peer.user.id, org.id);
    await loginAs(peer.user.id);

    const res = await getCase(caseReq(c.id), { params: { caseId: c.id } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.proofs.map((p: { title: string }) => p.title)).toEqual(['orgVis']);
  });

  it('hidden-vault linked proof never leaks to non-owner peers', async () => {
    const owner = await createTestUser({ role: 'COMPANY' });
    const org = await createTestOrg(owner.user.id);
    await joinOrg(owner.user.id, org.id);
    const c = await createTestCase(owner.user.id, { orgId: org.id });

    const hidden = await createTestProof(owner.user.id, {
      title: 'hidden',
      orgId: org.id,
      visibility: 'ORG',
    });
    await db().preservationConfig.create({
      data: { proofId: hidden.id, hiddenVaultMode: true },
    });
    await linkCaseProof(c.id, hidden.id);

    const peer = await createTestUser({ email: 'peer@iproofnow.dev', role: 'COMPANY' });
    await joinOrg(peer.user.id, org.id);
    await loginAs(peer.user.id);

    const res = await getCase(caseReq(c.id), { params: { caseId: c.id } });
    const body = await res.json();
    expect(body.proofs).toEqual([]);
  });

  it('foreign user → 404 (don\'t leak existence)', async () => {
    const owner = await createTestUser();
    const c = await createTestCase(owner.user.id);

    const stranger = await createTestUser({ email: 'stranger@iproofnow.dev' });
    await loginAs(stranger.user.id);

    const res = await getCase(caseReq(c.id), { params: { caseId: c.id } });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/cases/:caseId', () => {
  it('owner updates title + status; audits with meta.fields', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);
    const c = await createTestCase(user.id, { title: 'old' });

    const res = await patchCase(
      buildJsonRequest(
        `http://localhost/api/cases/${c.id}`,
        'PATCH',
        { title: 'new', status: 'archived' }
      ) as NextRequest,
      { params: { caseId: c.id } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.case.title).toBe('new');
    expect(body.case.status).toBe('archived');

    const audit = await db().auditLog.findFirst({
      where: { entityId: c.id, action: 'case.updated' },
    });
    const meta = audit?.meta as { fields: string[] };
    expect(meta.fields.sort()).toEqual(['status', 'title']);
  });

  it('non-owner same-org → 403 (write is owner-only even within an org)', async () => {
    const owner = await createTestUser({ role: 'COMPANY' });
    const org = await createTestOrg(owner.user.id);
    await joinOrg(owner.user.id, org.id);
    const c = await createTestCase(owner.user.id, { orgId: org.id });

    const peer = await createTestUser({ email: 'peer@iproofnow.dev', role: 'COMPANY' });
    await joinOrg(peer.user.id, org.id);
    await loginAs(peer.user.id);

    const res = await patchCase(
      buildJsonRequest(`http://localhost/api/cases/${c.id}`, 'PATCH', { title: 'x' }) as NextRequest,
      { params: { caseId: c.id } }
    );
    expect(res.status).toBe(403);
  });

  it('missing case → 404', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);
    const res = await patchCase(
      buildJsonRequest('http://localhost/api/cases/nope', 'PATCH', { title: 'x' }) as NextRequest,
      { params: { caseId: 'nope' } }
    );
    expect(res.status).toBe(404);
  });

  it('empty body → 400', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);
    const c = await createTestCase(user.id);
    const res = await patchCase(
      buildJsonRequest(`http://localhost/api/cases/${c.id}`, 'PATCH', {}) as NextRequest,
      { params: { caseId: c.id } }
    );
    expect(res.status).toBe(400);
  });
});
