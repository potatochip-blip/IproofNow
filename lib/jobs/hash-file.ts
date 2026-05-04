import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { prisma } from '../db';
import { logger } from '../logger';
import { getObjectStream } from '../storage';
import type { JobHandler } from '../jobs';

type HashFilePayload = { fileId: string };

function isHashFilePayload(p: unknown): p is HashFilePayload {
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof (p as { fileId?: unknown }).fileId === 'string'
  );
}

/**
 * proof_file.hash — fills `ProofFile.fileHash` + flips `hashStatus`.
 *
 * Streams the object out of S3 through a SHA-256 hasher rather than
 * buffering the whole file (uploads can be up to 100 MB; running the
 * worker as a separate tick keeps the user-facing upload response
 * latency-bounded).
 *
 * On unrecoverable error: flips hashStatus to FAILED so the frontend can
 * surface "hash unavailable" instead of indefinite spinner. The job runner
 * then schedules retry / terminal FAILED via its own policy.
 */
export const handleHashFile: JobHandler = async (payload) => {
  if (!isHashFilePayload(payload)) {
    throw new Error('hash-file: invalid payload (expected { fileId: string })');
  }
  const { fileId } = payload;

  const file = await prisma.proofFile.findUnique({ where: { id: fileId } });
  if (!file) {
    // No file → nothing to hash. Treat as a terminal no-op so the job
    // doesn't retry forever (e.g. file deleted between enqueue and run).
    logger.warn('hash-file.missing', { fileId });
    return;
  }

  const hash = createHash('sha256');
  let stream;
  try {
    stream = await getObjectStream(file.storagePath);
    await pipeline(
      stream,
      new Writable({
        write(chunk, _enc, cb) {
          hash.update(chunk);
          cb();
        },
      })
    );
  } catch (err) {
    await prisma.proofFile.update({
      where: { id: fileId },
      data: { hashStatus: 'FAILED' },
    });
    throw err;
  }

  const digest = hash.digest('hex');
  await prisma.proofFile.update({
    where: { id: fileId },
    data: { fileHash: digest, hashStatus: 'COMPLETE' },
  });
};
