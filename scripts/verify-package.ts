/**
 * Phase 9 — standalone offline evidence-package verifier.
 *
 * Confirms an iProofNow evidence package is authentic and unmodified using
 * ONLY the downloaded files — NO database, NO network, NO iProofNow server.
 * This is the proof that the "verifiable offline by a third party" claim is
 * real: a court or opposing counsel runs this with the public bundle.
 *
 * Inputs:
 *   <bundle.zip>      — the evidence package (GET /api/packages/:id download).
 *   <bundle.zip.sig>  — the detached signature sidecar (from the verify
 *                       endpoint's signatureUrl).
 *   [trustedKeyId]    — optional: iProofNow's published signing-key
 *                       fingerprint. When given, the script also asserts the
 *                       package was signed by that exact key.
 *
 * It re-hashes the zip, checks the hash against the signed digest, and
 * verifies the ed25519 signature with the public key embedded in the .sig.
 * ed25519 is asymmetric — this needs no secret, and possessing these files
 * does not let anyone forge a different valid package.
 *
 * Usage:
 *   pnpm tsx scripts/verify-package.ts bundle.zip bundle.zip.sig
 *   pnpm tsx scripts/verify-package.ts bundle.zip bundle.zip.sig 1a2b3c4d5e6f7a8b
 *
 * Exit code: 0 = authentic & intact, 1 = verification failed, 2 = bad usage.
 */

import { readFileSync } from 'node:fs';
import { verifyPackageBytes, type PackageSignatureFile } from '../lib/package-sig';

const REQUIRED_SIG_FIELDS: Array<keyof PackageSignatureFile> = [
  'algorithm',
  'signingKeyId',
  'contentHash',
  'signature',
  'publicKey',
];

function main(): void {
  const [zipPath, sigPath, trustedKeyId] = process.argv.slice(2);
  if (!zipPath || !sigPath) {
    // eslint-disable-next-line no-console
    console.error(
      'Usage: pnpm tsx scripts/verify-package.ts <bundle.zip> <bundle.zip.sig> [trustedKeyId]'
    );
    process.exit(2);
  }

  let zipBytes: Buffer;
  let sig: PackageSignatureFile;
  try {
    zipBytes = readFileSync(zipPath);
    sig = JSON.parse(readFileSync(sigPath, 'utf8')) as PackageSignatureFile;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Could not read inputs: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }

  const missing = REQUIRED_SIG_FIELDS.filter((f) => sig[f] === undefined);
  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`Signature file is missing fields: ${missing.join(', ')}`);
    process.exit(2);
  }
  if (sig.algorithm !== 'ed25519') {
    // eslint-disable-next-line no-console
    console.error(`Unsupported signature algorithm: ${sig.algorithm}`);
    process.exit(2);
  }

  const result = verifyPackageBytes(zipBytes, sig, trustedKeyId);

  /* eslint-disable no-console */
  console.log('');
  console.log(`  package        ${sig.packageId ?? '(unknown)'}`);
  console.log(`  signing key    ${sig.signingKeyId}`);
  console.log(`  signed at      ${sig.signedAt ?? '(unknown)'}`);
  console.log(`  zip digest     ${result.digestMatches ? 'OK — matches signed digest' : 'MISMATCH'}`);
  console.log(`  signature      ${result.signatureValid ? 'OK — valid ed25519 signature' : 'INVALID'}`);
  console.log(`  key identity   ${result.keyIdMatches ? 'OK' : 'UNTRUSTED / INCONSISTENT'}`);
  console.log('');
  if (result.ok) {
    console.log('  ✓ AUTHENTIC — this package was signed by iProofNow and is unmodified.');
  } else {
    console.log(`  ✗ VERIFICATION FAILED — ${result.reason}`);
  }
  console.log('');
  /* eslint-enable no-console */

  process.exit(result.ok ? 0 : 1);
}

main();
