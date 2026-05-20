import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';

/**
 * Phase 9 — detached ed25519 signing for evidence packages.
 *
 * Why asymmetric (vs the HMAC of lib/audit-sig.ts): an evidence package is
 * handed to third parties — courts, opposing counsel, auditors — who must be
 * able to verify it WITHOUT trusting iProofNow, and who must NOT be able to
 * forge one. HMAC can't do that: its verify key is its forge key. ed25519
 * signs with a private key that never leaves the signer and verifies with a
 * public key that can be published freely. The Phase 6 audit chain stays
 * HMAC — it's internal, only iProofNow ever verifies it.
 *
 * This file is the single swap point for a real KMS / HSM later: the call
 * sites (build-package, the verify route, the offline script) only touch
 * the functions below.
 *
 * Key handling:
 *   * Production / dev: PACKAGE_SIGNING_PRIVATE_KEY MUST be set — a base64
 *     pkcs8 DER ed25519 private key. Module load throws if missing/malformed
 *     so a misconfigured deploy fails fast.
 *   * Tests: a fixed test keypair is used when NODE_ENV === 'test'. Never
 *     use this key anywhere else.
 *
 * Generate a production key:
 *   node -e "const c=require('crypto');const{privateKey}=c.generateKeyPairSync('ed25519');console.log(privateKey.export({type:'pkcs8',format:'der'}).toString('base64'))"
 */

// Fixed ed25519 test keypair — NODE_ENV=test only.
const TEST_PRIVATE_KEY_B64 =
  'MC4CAQAwBQYDK2VwBCIEIPUDV37RhHRMUxyoV1+nVRYsmhIZ3JE03SIOp8f2CtCA';

function loadPrivateKey(): KeyObject {
  const env = process.env.PACKAGE_SIGNING_PRIVATE_KEY;
  const b64 = env ?? (process.env.NODE_ENV === 'test' ? TEST_PRIVATE_KEY_B64 : undefined);
  if (!b64) {
    throw new Error(
      'PACKAGE_SIGNING_PRIVATE_KEY missing — set a base64 pkcs8 DER ed25519 private key. ' +
        'Generate: node -e "const c=require(\'crypto\');console.log(c.generateKeyPairSync(\'ed25519\').privateKey.export({type:\'pkcs8\',format:\'der\'}).toString(\'base64\'))"'
    );
  }
  let priv: KeyObject;
  try {
    priv = createPrivateKey({
      key: Buffer.from(b64, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
  } catch (err) {
    throw new Error(
      'PACKAGE_SIGNING_PRIVATE_KEY is not a valid base64 pkcs8 DER key: ' +
        (err instanceof Error ? err.message : String(err))
    );
  }
  if (priv.asymmetricKeyType !== 'ed25519') {
    throw new Error(
      `PACKAGE_SIGNING_PRIVATE_KEY must be an ed25519 key, got ${priv.asymmetricKeyType}`
    );
  }
  return priv;
}

// The private key is loaded LAZILY (not at module import). This is the one
// deliberate difference from lib/audit-sig.ts's eager load: the offline
// verifier (scripts/verify-package.ts) imports this module purely for
// verifyPackageBytes — it has only the PUBLIC key and must never need
// PACKAGE_SIGNING_PRIVATE_KEY. Lazy loading means a verify-only consumer
// never triggers the private-key requirement; the signing path validates
// the key on the first signPackageDigest call (the first package build).
let cachedPrivateKey: KeyObject | null = null;
let cachedPublicKeyDer: Buffer | null = null;
let cachedSigningKeyId: string | null = null;

function privateKey(): KeyObject {
  if (!cachedPrivateKey) cachedPrivateKey = loadPrivateKey();
  return cachedPrivateKey;
}

function publicKeyDer(): Buffer {
  if (!cachedPublicKeyDer) {
    cachedPublicKeyDer = createPublicKey(privateKey()).export({
      type: 'spki',
      format: 'der',
    }) as Buffer;
  }
  return cachedPublicKeyDer;
}

/** Stable short fingerprint of a public key — first 16 hex of its sha256. */
function fingerprint(spkiDer: Buffer): string {
  return createHash('sha256').update(spkiDer).digest('hex').slice(0, 16);
}

/** The signing key's public half, base64 spki DER — safe to publish. */
export function getPackagePublicKey(): string {
  return publicKeyDer().toString('base64');
}

/** The configured signing key's fingerprint — a verifier checks against this. */
export function getSigningKeyId(): string {
  if (!cachedSigningKeyId) cachedSigningKeyId = fingerprint(publicKeyDer());
  return cachedSigningKeyId;
}

/**
 * Sign a package content digest. Returns the ed25519 signature (hex) and the
 * id of the key that produced it.
 */
export function signPackageDigest(digest: Buffer): {
  signature: string;
  signingKeyId: string;
} {
  const sig = cryptoSign(null, digest, privateKey());
  return { signature: sig.toString('hex'), signingKeyId: getSigningKeyId() };
}

/**
 * Verify an ed25519 signature over `digest`. With no `publicKeyB64` the
 * server's configured public key is used (lazy-loads the key); an offline
 * verifier passes the public key from the detached .sig material, which
 * never touches the private key. Returns false (never throws) for malformed
 * input so callers can treat it as a pure predicate.
 */
export function verifyPackageSignature(
  digest: Buffer,
  signature: string,
  publicKeyB64?: string
): boolean {
  if (!/^[0-9a-fA-F]+$/.test(signature) || signature.length === 0) return false;
  try {
    const key = createPublicKey(
      publicKeyB64
        ? { key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' }
        : privateKey()
    );
    return cryptoVerify(null, digest, key, Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

/** The detached signature material — what a `.zip.sig` sidecar carries. */
export type PackageSignatureFile = {
  packageId: string;
  algorithm: 'ed25519';
  signingKeyId: string;
  /** sha256 of the whole .zip, hex. */
  contentHash: string;
  /** ed25519 signature over the contentHash bytes, hex. */
  signature: string;
  signedAt: string;
  /** Public key, base64 spki DER — convenience; a verifier still checks the keyId. */
  publicKey: string;
};

export type OfflineVerifyResult = {
  ok: boolean;
  digestMatches: boolean;
  signatureValid: boolean;
  keyIdMatches: boolean;
  reason?: string;
};

/**
 * Offline verification core — used by both the API verify route and the
 * standalone scripts/verify-package.ts. Pure: no DB, no network, no S3.
 *
 * Given the raw .zip bytes and the parsed .sig material, it confirms:
 *   - the zip hashes to the digest the signature covers,
 *   - the ed25519 signature is valid under the sig's public key,
 *   - (optionally) the public key's fingerprint matches a trusted keyId.
 */
export function verifyPackageBytes(
  zipBytes: Buffer,
  sig: PackageSignatureFile,
  trustedKeyId?: string
): OfflineVerifyResult {
  const actualHash = createHash('sha256').update(zipBytes).digest('hex');
  const digestMatches = actualHash === sig.contentHash;

  const digestBuf = Buffer.from(sig.contentHash, 'hex');
  const signatureValid = verifyPackageSignature(digestBuf, sig.signature, sig.publicKey);

  const keyFingerprint = fingerprint(Buffer.from(sig.publicKey, 'base64'));
  const keyIdMatches =
    keyFingerprint === sig.signingKeyId &&
    (trustedKeyId === undefined || trustedKeyId === sig.signingKeyId);

  const ok = digestMatches && signatureValid && keyIdMatches;
  let reason: string | undefined;
  if (!digestMatches) reason = 'zip content does not match the signed digest';
  else if (!signatureValid) reason = 'ed25519 signature is invalid';
  else if (!keyIdMatches) reason = 'signing key id is untrusted or inconsistent';

  return { ok, digestMatches, signatureValid, keyIdMatches, reason };
}
