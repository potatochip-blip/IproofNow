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

/**
 * The closed set of AuditLog actions that *establish a proof's content*.
 * The digest folds in ONLY these rows' entryHashes.
 *
 * Why this filter exists (Phase 8): a proof's AuditLog stream also carries
 * post-seal access events — `proof.verified`, `proof.exported`,
 * `proof.hidden.revealed`, `proof.anchor.verified` — all tagged
 * `entityType='Proof'`. Every verify appends a `proof.verified` row, so an
 * unfiltered digest would drift on every verification and a re-check would
 * false-positive TAMPERED. Restricting to content-establishing actions —
 * all of which are frozen once a proof is SEALED — makes the digest
 * permanently stable, which is what lets it be recomputed and compared.
 */
const CONTENT_DIGEST_ACTIONS = [
  'proof.created',
  'proof.updated',
  'proof.file.uploaded',
  'proof.attestation.saved',
  'proof.sealed',
] as const;

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
 *   1. audit — every content-establishing AuditLog.entryHash for this proof
 *      (see CONTENT_DIGEST_ACTIONS), ordered (createdAt asc, id asc).
 *      Because AuditLog is itself a tamper-evident hash chain (Phase 6),
 *      folding the entryHashes in commits the anchor to the proof's content
 *      history transitively.
 *   2. files — every ProofFile.fileHash, ordered (id asc).
 *   3. attestation — canonical JSON of the ProofAttestation content fields.
 *
 * Time-stability: the digest of a SEALED proof never changes — every input
 * (content audit rows, file hashes, attestation) is frozen at seal. That is
 * what makes it sound to recompute at verify time and compare against
 * ProofAnchor.contentHash. See `computeProofDigestCached` for the memo that
 * exploits this.
 *
 * Throws ProofDigestNotReadyError when any file is still hashStatus=PENDING.
 * Throws a plain Error when any file is hashStatus=FAILED (unrecoverable).
 */
export async function computeProofDigest(proofId: string): Promise<Buffer> {
  const [auditRows, files, attestation] = await Promise.all([
    prisma.auditLog.findMany({
      where: {
        entityType: 'Proof',
        entityId: proofId,
        action: { in: [...CONTENT_DIGEST_ACTIONS] },
      },
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

// ─── Memoized recompute ───────────────────────────────────────────────────
//
// Phase 8: the verify endpoint recomputes the digest on every call. For a
// heavily-verified PUBLIC proof that's three DB reads per request for a
// value that never changes (a sealed proof's digest is frozen). The cache
// is keyed by (proofId, Proof.updatedAt): a SEALED proof can't be PATCHed
// (the route 409s) so its updatedAt is stable and the entry lives for the
// process lifetime; any change to the proof bumps updatedAt and naturally
// invalidates the entry. Bounded by a simple FIFO cap.

const DIGEST_CACHE_MAX = 500;
const digestCache = new Map<string, { updatedAt: number; digest: Buffer }>();

/**
 * computeProofDigest with a (proofId, updatedAt)-keyed memo. Pass the proof
 * row so the cache can key on its updatedAt. Errors (ProofDigestNotReadyError
 * / FAILED) are never cached — they propagate from the underlying compute.
 */
export async function computeProofDigestCached(proof: {
  id: string;
  updatedAt: Date;
}): Promise<Buffer> {
  const stamp = proof.updatedAt.getTime();
  const hit = digestCache.get(proof.id);
  if (hit && hit.updatedAt === stamp) {
    return hit.digest;
  }

  const digest = await computeProofDigest(proof.id);

  if (digestCache.size >= DIGEST_CACHE_MAX) {
    const oldest = digestCache.keys().next().value;
    if (oldest !== undefined) digestCache.delete(oldest);
  }
  digestCache.set(proof.id, { updatedAt: stamp, digest });
  return digest;
}

/** Drop the memo cache. Test helper. */
export function clearProofDigestCache(): void {
  digestCache.clear();
}
