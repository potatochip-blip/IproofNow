import { createHash } from 'node:crypto';
import { prisma } from '../db';

/**
 * Thrown when a proof's files haven't finished hashing yet. The anchor
 * submit handler treats this as "retry later" (re-enqueue with delay)
 * rather than a hard failure — the Phase 5 `proof_file.hash` worker just
 * hasn't caught up. A FAILED file hash is NOT this error: that's a plain
 * Error so the job runner escalates it.
 */
export class ProofDigestNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProofDigestNotReadyError';
  }
}

/** Recursive sorted-key JSON — mirrors lib/audit.ts canonical encoding. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

/**
 * Compute the content digest that gets anchored to Bitcoin via OpenTimestamps.
 *
 * The digest is sha256 over a deterministic, NUL-delimited byte-string of
 * three sections, in canonical order:
 *
 *   1. audit — every AuditLog.entryHash for this proof, ordered
 *      (createdAt asc, id asc). Because AuditLog is itself a tamper-evident
 *      hash chain (Phase 6), folding the entryHashes in means the anchor
 *      commits to the proof's entire audit history transitively.
 *   2. files — every ProofFile.fileHash, ordered (id asc).
 *   3. attestation — canonical JSON of the ProofAttestation content fields.
 *
 * Determinism matters: anchor/verify (and the Phase 8 tamper check)
 * recompute this and compare to ProofAnchor.contentHash. Any later mutation
 * of the proof's audit chain / files / attestation changes the digest.
 *
 * Throws ProofDigestNotReadyError when any file is still hashStatus=PENDING.
 * Throws a plain Error when any file is hashStatus=FAILED (unrecoverable).
 */
export async function computeProofDigest(proofId: string): Promise<Buffer> {
  const [auditRows, files, attestation] = await Promise.all([
    prisma.auditLog.findMany({
      where: { entityType: 'Proof', entityId: proofId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { entryHash: true },
    }),
    prisma.proofFile.findMany({
      where: { proofId },
      orderBy: { id: 'asc' },
      select: { id: true, fileHash: true, hashStatus: true },
    }),
    prisma.proofAttestation.findUnique({ where: { proofId } }),
  ]);

  const failed = files.filter((f) => f.hashStatus === 'FAILED');
  if (failed.length > 0) {
    throw new Error(
      `proof ${proofId}: ${failed.length} file hash(es) FAILED — cannot anchor`
    );
  }
  const pending = files.filter((f) => f.hashStatus !== 'COMPLETE');
  if (pending.length > 0) {
    throw new ProofDigestNotReadyError(
      `proof ${proofId}: ${pending.length} file hash(es) not yet COMPLETE`
    );
  }

  const auditSection = auditRows.map((r) => r.entryHash).join(',');
  const fileSection = files.map((f) => f.fileHash ?? '').join(',');
  const attestationSection = attestation
    ? canonicalJson({
        attestationName: attestation.attestationName,
        attestationLocation: attestation.attestationLocation,
        attestationText: attestation.attestationText,
        attestationFileId: attestation.attestationFileId,
      })
    : '';

  const bytes = [
    'audit:' + auditSection,
    'files:' + fileSection,
    'attestation:' + attestationSection,
  ].join('\x00');

  return createHash('sha256').update(bytes).digest();
}
