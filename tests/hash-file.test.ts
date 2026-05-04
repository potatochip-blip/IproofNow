import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
import { POST as uploadFile } from '@/app/api/proofs/[proofId]/files/route';
import { drainJobs } from '@/lib/jobs';
import { isStorageReachable } from '@/lib/storage';
import {
  buildMultipartRequest,
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

describe('proof_file.hash worker (MinIO-gated)', () => {
  it('uploaded file is enqueued, drains to COMPLETE with correct sha256', async (t) => {
    if (!(await isStorageReachable())) {
      t.skip();
      return;
    }
    const { user } = await createTestUser();
    await loginAs(user.id);
    const proof = await createTestProof(user.id);
    const bytes = new TextEncoder().encode('hash-me-please');
    const expected = createHash('sha256').update(bytes).digest('hex');

    const upRes = await uploadFile(
      buildMultipartRequest(
        `http://localhost/api/proofs/${proof.id}/files`,
        bytes,
        'h.txt',
        'text/plain'
      ) as NextRequest,
      { params: { proofId: proof.id } }
    );
    expect(upRes.status).toBe(201);
    const upBody = await upRes.json();
    const fileId = upBody.file.id as string;
    expect(upBody.file.hashStatus).toBe('pending');

    // The upload route enqueued a proof_file.hash job — drain.
    const ran = await drainJobs();
    expect(ran).toBeGreaterThan(0);

    const file = await db().proofFile.findUnique({ where: { id: fileId } });
    expect(file?.hashStatus).toBe('COMPLETE');
    expect(file?.fileHash).toBe(expected);
  });

  it('missing file: terminal no-op (no throw, no row to update)', async () => {
    // No MinIO involvement — purely tests the missing-file guard.
    const { user } = await createTestUser();
    await db().job.create({
      data: {
        type: 'proof_file.hash',
        payload: { fileId: 'does-not-exist' },
      },
    });
    // Even though there is no User context here, drainJobs runs handlers
    // directly. Should not throw, should not retry.
    const ran = await drainJobs();
    expect(ran).toBe(1);
    const job = await db().job.findFirst({ where: { type: 'proof_file.hash' } });
    expect(job?.status).toBe('COMPLETE');
  });
});
