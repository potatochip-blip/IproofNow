import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drainJobs, enqueueJob, runDueJobs } from '@/lib/jobs';
import { createTestUser, db, truncateAll } from './helpers';
import { resetCookieJar } from './cookie-jar';
import { startOtsStub, type OtsStub } from './ots-stub';

// The proof.anchor handler is used here as a representative real handler.
// Phase 7 made it talk to OTS calendars, so the runner tests point it at
// the in-process stub.
let stub: OtsStub;
let prevCalendars: string | undefined;
let prevExplorer: string | undefined;

beforeAll(async () => {
  stub = await startOtsStub();
  prevCalendars = process.env.OTS_CALENDAR_URLS;
  prevExplorer = process.env.BITCOIN_EXPLORER_URL;
  process.env.OTS_CALENDAR_URLS = stub.url;
  process.env.BITCOIN_EXPLORER_URL = stub.url;
});

beforeEach(async () => {
  await truncateAll();
  resetCookieJar();
  stub.setMode('pending');
});

afterAll(async () => {
  await stub.close();
  process.env.OTS_CALENDAR_URLS = prevCalendars;
  process.env.BITCOIN_EXPLORER_URL = prevExplorer;
  await db().$disconnect();
});

describe('lib/jobs runner', () => {
  it('runDueJobs() returns null when queue is idle', async () => {
    const result = await runDueJobs();
    expect(result).toBeNull();
  });

  it('claims a due job exactly once and marks it COMPLETE on handler success', async () => {
    // proof.anchor as a representative handler — submits to the OTS stub.
    const { user } = await createTestUser();
    const proof = await db().proof.create({
      data: {
        ownerUserId: user.id,
        title: 'p',
        categoryKey: 'general',
        proofType: 'document',
      },
    });

    await enqueueJob('proof.anchor', { proofId: proof.id });
    const result = await runDueJobs();
    expect(result?.status).toBe('COMPLETE');

    const anchor = await db().proofAnchor.findUnique({
      where: { proofId: proof.id },
    });
    expect(anchor?.status).toBe('PENDING');

    // The follow-up upgrade job is scheduled ~1h out, so nothing is due now.
    expect(await runDueJobs()).toBeNull();
  });

  it('respects runAfter — jobs scheduled for the future are not claimed', async () => {
    const { user } = await createTestUser();
    const proof = await db().proof.create({
      data: {
        ownerUserId: user.id,
        title: 'p',
        categoryKey: 'general',
        proofType: 'document',
      },
    });

    const future = new Date(Date.now() + 60_000);
    await enqueueJob('proof.anchor', { proofId: proof.id }, { runAfter: future });
    expect(await runDueJobs()).toBeNull();

    // Force the row backwards in time to simulate the wait.
    await db().job.updateMany({
      where: { type: 'proof.anchor' },
      data: { runAfter: new Date(Date.now() - 1000) },
    });
    const result = await runDueJobs();
    expect(result?.status).toBe('COMPLETE');
  });

  it('retries with backoff on handler failure, then terminal FAILED + audit', async () => {
    // Enqueue a job whose payload is invalid for the anchor handler so it
    // throws every time. We bypass enqueueJob's typed surface to land an
    // intentionally bad payload.
    const job = await db().job.create({
      data: {
        type: 'proof.anchor',
        payload: { proofId: 42 } as object, // wrong type triggers handler throw
        runAfter: new Date(),
      },
    });

    // Attempt 1 → bumps to PENDING with future runAfter (1s)
    const r1 = await runDueJobs();
    expect(r1?.status).toBe('PENDING');
    let row = await db().job.findUnique({ where: { id: job.id } });
    expect(row?.attempts).toBe(1);
    expect(row?.status).toBe('PENDING');
    expect(row?.lastError).toMatch(/invalid payload/);

    // Force runAfter back so the next claim can fire without sleeping.
    await db().job.update({
      where: { id: job.id },
      data: { runAfter: new Date(Date.now() - 1000) },
    });

    // Attempt 2 → still PENDING with longer backoff
    const r2 = await runDueJobs();
    expect(r2?.status).toBe('PENDING');
    row = await db().job.findUnique({ where: { id: job.id } });
    expect(row?.attempts).toBe(2);

    // Force runAfter back again.
    await db().job.update({
      where: { id: job.id },
      data: { runAfter: new Date(Date.now() - 1000) },
    });

    // Attempt 3 → terminal FAILED
    const r3 = await runDueJobs();
    expect(r3?.status).toBe('FAILED');
    row = await db().job.findUnique({ where: { id: job.id } });
    expect(row?.attempts).toBe(3);
    expect(row?.status).toBe('FAILED');
    expect(row?.completedAt).not.toBeNull();

    // Internal job.failed audit was emitted on terminal.
    const audit = await db().auditLog.findFirst({
      where: { entityType: 'Job', entityId: job.id, action: 'job.failed' },
    });
    expect(audit).toBeTruthy();
    const meta = audit?.meta as { type: string; attempts: number; error: string };
    expect(meta.type).toBe('proof.anchor');
    expect(meta.attempts).toBe(3);
  });

  it('drainJobs() loops until the queue is empty', async () => {
    const { user } = await createTestUser();
    const ids = await Promise.all(
      [0, 1, 2].map((i) =>
        db()
          .proof.create({
            data: {
              ownerUserId: user.id,
              title: `p${i}`,
              categoryKey: 'general',
              proofType: 'document',
            },
          })
          .then((p) => p.id)
      )
    );
    for (const proofId of ids) {
      await enqueueJob('proof.anchor', { proofId });
    }

    const ran = await drainJobs();
    expect(ran).toBe(3);

    const anchors = await db().proofAnchor.findMany();
    expect(anchors.map((a) => a.proofId).sort()).toEqual([...ids].sort());

    expect(await runDueJobs()).toBeNull();
  });
});
