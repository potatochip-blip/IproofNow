import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Phase 6 — KMS-style signing wrapper for audit entry hashes.
 *
 * The interface mirrors the AWS KMS pattern intentionally:
 *
 *   sign(bytes)           → signature hex
 *   verify(bytes, sig)    → boolean (constant-time compare)
 *
 * Today the implementation is a local HMAC-SHA-256 keyed by
 * `process.env.AUDIT_SIGNING_KEY` (32 bytes / 64 hex chars). When we move
 * to a real KMS, this file is what gets rewritten — the call sites in
 * lib/audit.ts and lib/audit-chain.ts don't change.
 *
 * Key handling:
 *   * Production / dev: AUDIT_SIGNING_KEY MUST be set; module load throws
 *     if missing or malformed so a misconfigured deploy fails fast.
 *   * Tests: a fixed test key is used when NODE_ENV === 'test' so the
 *     suite doesn't depend on .env wiring. Never use this key in any
 *     other environment.
 */

const TEST_KEY_HEX =
  '0000000000000000000000000000000000000000000000000000000000000001';

function loadKey(): Buffer {
  const env = process.env.AUDIT_SIGNING_KEY;
  if (!env) {
    if (process.env.NODE_ENV === 'test') {
      return Buffer.from(TEST_KEY_HEX, 'hex');
    }
    throw new Error(
      'AUDIT_SIGNING_KEY missing — set a 64-char hex string (32 bytes). ' +
        'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(env)) {
    throw new Error(
      'AUDIT_SIGNING_KEY must be exactly 64 hex characters (32 bytes), ' +
        `got length ${env.length}`
    );
  }
  return Buffer.from(env, 'hex');
}

// Resolve at module load so a missing/malformed key crashes the process at
// startup, not on the first audit write.
const key = loadKey();

function toBuffer(input: string | Buffer): Buffer {
  return typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
}

/** Returns hex-encoded HMAC-SHA-256 of `input` under the signing key. */
export function sign(input: string | Buffer): string {
  return createHmac('sha256', key).update(toBuffer(input)).digest('hex');
}

/**
 * Constant-time signature check. Returns false (never throws) for
 * malformed / wrong-length signatures so callers can treat verify() as a
 * pure boolean predicate.
 */
export function verify(input: string | Buffer, signature: string): boolean {
  if (!/^[0-9a-fA-F]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', key).update(toBuffer(input)).digest();
  const provided = Buffer.from(signature, 'hex');
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

/** Convenience: verify a signed AuditLog row's signature against entryHash. */
export function verifyAuditSignature(row: {
  entryHash: string;
  signature: string | null;
}): boolean {
  if (row.signature === null) return false;
  return verify(row.entryHash, row.signature);
}
