import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  signPackageDigest,
  verifyPackageSignature,
  verifyPackageBytes,
  getPackagePublicKey,
  getSigningKeyId,
  type PackageSignatureFile,
} from '@/lib/package-sig';

/** Build a genuine detached-signature file for some bytes. */
function signBytes(bytes: Buffer): PackageSignatureFile {
  const contentHash = createHash('sha256').update(bytes).digest();
  const { signature, signingKeyId } = signPackageDigest(contentHash);
  return {
    packageId: 'pkg-test',
    algorithm: 'ed25519',
    signingKeyId,
    contentHash: contentHash.toString('hex'),
    signature,
    signedAt: new Date().toISOString(),
    publicKey: getPackagePublicKey(),
  };
}

describe('lib/package-sig — ed25519 detached signatures', () => {
  it('sign/verify roundtrip succeeds for the same digest', () => {
    const digest = createHash('sha256').update('a-package').digest();
    const { signature } = signPackageDigest(digest);
    expect(signature).toMatch(/^[0-9a-f]+$/);
    expect(verifyPackageSignature(digest, signature)).toBe(true);
  });

  it('verify rejects a tampered digest under the same signature', () => {
    const digest = createHash('sha256').update('original').digest();
    const { signature } = signPackageDigest(digest);
    const other = createHash('sha256').update('tampered').digest();
    expect(verifyPackageSignature(other, signature)).toBe(false);
  });

  it('verify rejects a malformed signature without throwing', () => {
    const digest = createHash('sha256').update('x').digest();
    expect(verifyPackageSignature(digest, 'not-hex')).toBe(false);
    expect(verifyPackageSignature(digest, '')).toBe(false);
    expect(verifyPackageSignature(digest, 'ab'.repeat(10))).toBe(false);
  });

  it('signing key id is a stable 16-hex fingerprint', () => {
    expect(getSigningKeyId()).toMatch(/^[0-9a-f]{16}$/);
    expect(getSigningKeyId()).toBe(getSigningKeyId());
  });

  it('getPackagePublicKey returns base64 that verifies a signature', () => {
    const pub = getPackagePublicKey();
    expect(pub).toMatch(/^[A-Za-z0-9+/]+=*$/);
    const digest = createHash('sha256').update('via-public-key').digest();
    const { signature } = signPackageDigest(digest);
    // Verifying with the explicitly-passed public key must agree.
    expect(verifyPackageSignature(digest, signature, pub)).toBe(true);
  });

  it('verifyPackageBytes accepts a genuine package', () => {
    const zip = Buffer.from('PK\x03\x04 ...pretend zip bytes...');
    const sig = signBytes(zip);
    const result = verifyPackageBytes(zip, sig);
    expect(result).toMatchObject({
      ok: true,
      digestMatches: true,
      signatureValid: true,
      keyIdMatches: true,
    });
  });

  it('verifyPackageBytes rejects a tampered zip', () => {
    const zip = Buffer.from('genuine bytes');
    const sig = signBytes(zip);
    const tampered = Buffer.from('genuine bytez'); // one byte changed
    const result = verifyPackageBytes(tampered, sig);
    expect(result.ok).toBe(false);
    expect(result.digestMatches).toBe(false);
    expect(result.reason).toMatch(/does not match/);
  });

  it('verifyPackageBytes rejects a tampered signature', () => {
    const zip = Buffer.from('some package');
    const sig = signBytes(zip);
    // Flip the signature to another valid-but-wrong one.
    sig.signature = signPackageDigest(
      createHash('sha256').update('different').digest()
    ).signature;
    const result = verifyPackageBytes(zip, sig);
    expect(result.ok).toBe(false);
    expect(result.signatureValid).toBe(false);
  });

  it('verifyPackageBytes flags an untrusted signing key id', () => {
    const zip = Buffer.from('a package');
    const sig = signBytes(zip);
    const result = verifyPackageBytes(zip, sig, 'deadbeefdeadbeef');
    expect(result.ok).toBe(false);
    expect(result.keyIdMatches).toBe(false);
  });

  it('signing fails fast when PACKAGE_SIGNING_PRIVATE_KEY is missing outside test env', async () => {
    vi.resetModules();
    const prevNodeEnv = process.env.NODE_ENV;
    const prevKey = process.env.PACKAGE_SIGNING_PRIVATE_KEY;
    Object.assign(process.env, { NODE_ENV: 'development' });
    delete process.env.PACKAGE_SIGNING_PRIVATE_KEY;
    try {
      const mod = await import('@/lib/package-sig');
      // Lazy load — the missing key surfaces on the first signing call.
      expect(() => mod.signPackageDigest(Buffer.alloc(32))).toThrow(
        /PACKAGE_SIGNING_PRIVATE_KEY/
      );
    } finally {
      Object.assign(process.env, { NODE_ENV: prevNodeEnv });
      if (prevKey !== undefined) process.env.PACKAGE_SIGNING_PRIVATE_KEY = prevKey;
      vi.resetModules();
    }
  });
});
