import type { Job, JobStatus, Prisma, PrismaClient } from '@prisma/client';
import { prisma } from './db';
import { logger } from './logger';
import { writeAudit } from './audit';

// ─── Public surface ───────────────────────────────────────────────────────

export type JobType =
  | 'evidence_package.build'
  | 'proof_file.hash'
  | 'proof.anchor';

export type JobHandler<P = unknown> = (
  payload: P,
  ctx: { jobId: string; attempts: number }
) => Promise<void>;

export type EnqueueOptions = {
  /** Delay first run; defaults to now. */
  runAfter?: Date;
  /**
   * Optional Prisma client (a transaction client) so callers can enqueue
   * atomically with their own state change. Falls back to the singleton.
   */
  tx?: Prisma_TxClient;
};

/**
 * Enqueue a job. Defaults to running ASAP. Pass `tx` to keep the enqueue
 * inside a caller-controlled transaction so "state change ↔ job exists" is
 * atomic (used by /seal, /files, /cases/:id/packages).
 */
export async function enqueueJob<T extends JobType>(
  type: T,
  payload: Record<string, unknown>,
  opts: EnqueueOptions = {}
): Promise<Job> {
  const client: Prisma_TxClient = opts.tx ?? prisma;
  return client.job.create({
    data: {
      type,
      payload: payload as Prisma.InputJsonValue,
      ...(opts.runAfter ? { runAfter: opts.runAfter } : {}),
    },
  });
}

// Narrow alias so callers don't have to import the full Prisma namespace.
type Prisma_TxClient = Pick<PrismaClient, 'job'>;

// ─── Handler registry ─────────────────────────────────────────────────────

// Lazy import — keeps lib/jobs.ts free of cycles back into job handlers and
// lets each handler module pull in its own deps (archiver, S3 GET, etc.)
// without making the runner pay for them on every request.
async function loadHandlers(): Promise<Record<string, JobHandler>> {
  const [{ handleHashFile }, { handleBuildPackage }, { handleAnchor }] =
    await Promise.all([
      import('./jobs/hash-file'),
      import('./jobs/build-package'),
      import('./jobs/anchor'),
    ]);
  return {
    'proof_file.hash': handleHashFile as JobHandler,
    'evidence_package.build': handleBuildPackage as JobHandler,
    'proof.anchor': handleAnchor as JobHandler,
  };
}

// ─── Retry policy ─────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 3;

/**
 * Exponential backoff. Attempt count is post-increment (so the first failure
 * passes attempts=1).
 *
 *   attempts=1 → 1s
 *   attempts=2 → 4s
 *   attempts=3 → terminal FAIL, no backoff
 *
 * Short enough to keep tests fast; meaningful enough in prod.
 */
function backoffSeconds(attempts: number): number {
  return Math.pow(4, attempts - 1);
}

// ─── Claim + run ──────────────────────────────────────────────────────────

type ClaimedJob = {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
};

/**
 * Claim the next due job using FOR UPDATE SKIP LOCKED so multiple worker
 * instances can run safely. Returns null when nothing's due.
 *
 * Uses raw SQL because Prisma's findFirst doesn't support row locks.
 */
async function claimNextDue(): Promise<ClaimedJob | null> {
  return prisma.$transaction(async (tx) => {
    // Two Postgres compatibility notes:
    //   1. `status::text = 'PENDING'` instead of `'PENDING'::"JobStatus"`:
    //      Prisma's $queryRaw can mangle the quoted enum-type cast; the
    //      text cast is bulletproof and costs us nothing.
    //   2. `(NOW() AT TIME ZONE 'UTC')::timestamp` for the time comparison:
    //      Prisma stores DateTime as `timestamp(3)` (no tz) interpreted
    //      as UTC. Postgres's NOW() returns `timestamptz`, and casting it
    //      directly to `timestamp` strips the tz at the session-local
    //      offset — so a NYC-tz session would compare runAfter against a
    //      value 4 hours behind real UTC. AT TIME ZONE 'UTC' first
    //      converts to UTC wall-clock, then the cast removes tz, giving
    //      a comparable tz-naive UTC timestamp regardless of session tz.
    const rows = await tx.$queryRaw<
      Array<{ id: string; type: string; payload: unknown; attempts: number }>
    >`
      SELECT id, type, payload, attempts
      FROM "Job"
      WHERE status::text = 'PENDING'
        AND "runAfter" <= (NOW() AT TIME ZONE 'UTC')::timestamp
      ORDER BY "runAfter" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `;
    const row = rows[0];
    if (!row) return null;

    await tx.job.update({
      where: { id: row.id },
      data: { status: 'RUNNING', attempts: { increment: 1 } },
    });

    return { ...row, attempts: row.attempts + 1 };
  });
}

async function markComplete(jobId: string): Promise<void> {
  await prisma.job.update({
    where: { id: jobId },
    data: { status: 'COMPLETE', completedAt: new Date(), lastError: null },
  });
}

async function markRetryOrFailed(
  job: ClaimedJob,
  err: unknown
): Promise<{ terminal: boolean }> {
  const message = err instanceof Error ? err.message : String(err);
  const truncated = message.slice(0, 1024);

  if (job.attempts >= MAX_ATTEMPTS) {
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: 'FAILED',
        lastError: truncated,
        completedAt: new Date(),
      },
    });

    // Internal-only audit so ops can spot terminally-broken handlers
    // without scraping logs. entityType='Job' keeps it isolated from
    // user-entity audit queries.
    await writeAudit({
      actorUserId: null,
      entityType: 'Job',
      entityId: job.id,
      action: 'job.failed',
      meta: { type: job.type, attempts: job.attempts, error: truncated },
    });

    return { terminal: true };
  }

  const runAfter = new Date(Date.now() + backoffSeconds(job.attempts) * 1000);
  await prisma.job.update({
    where: { id: job.id },
    data: { status: 'PENDING', lastError: truncated, runAfter },
  });
  return { terminal: false };
}

/**
 * Run one due job, if any. Returns the resulting status, or null when the
 * queue is idle. Concurrency is 1 per call — the cron tick (Phase 5 leaves
 * scheduling to operational config) decides how often this fires.
 */
export async function runDueJobs(): Promise<{
  jobId: string;
  status: JobStatus;
} | null> {
  const job = await claimNextDue();
  if (!job) return null;

  const handlers = await loadHandlers();
  const handler = handlers[job.type];
  if (!handler) {
    logger.error('jobs.no_handler', { jobId: job.id, type: job.type });
    await markRetryOrFailed(job, new Error(`No handler for type: ${job.type}`));
    return { jobId: job.id, status: 'FAILED' };
  }

  try {
    await handler(job.payload, { jobId: job.id, attempts: job.attempts });
    await markComplete(job.id);
    return { jobId: job.id, status: 'COMPLETE' };
  } catch (err) {
    logger.error('jobs.handler_failed', {
      jobId: job.id,
      type: job.type,
      attempts: job.attempts,
      err: err instanceof Error ? err.message : String(err),
    });
    const { terminal } = await markRetryOrFailed(job, err);
    return { jobId: job.id, status: terminal ? 'FAILED' : 'PENDING' };
  }
}

/**
 * Helper for tests + manual ops scripts: keep running due jobs until none
 * are due, with a hard cap so a broken handler (or a runAfter-in-future
 * loop) can't hang.
 */
export async function drainJobs(maxIterations = 50): Promise<number> {
  let ran = 0;
  for (let i = 0; i < maxIterations; i++) {
    const result = await runDueJobs();
    if (!result) return ran;
    ran++;
  }
  return ran;
}
