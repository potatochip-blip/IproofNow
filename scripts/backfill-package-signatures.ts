/**
 * Phase 9 one-shot — sign evidence packages built before Phase 9.
 *
 * Phase 9 adds a detached ed25519 signature to every package as it's built.
 * READY packages created earlier have no signature; the verify endpoint
 * reports them `signed:false`. This script retro-signs them: it downloads
 * each unsigned zip, hashes it, signs the digest, uploads the .sig sidecar,
 * and fills the EvidencePackage signing columns.
 *
 * It does NOT rebuild the zip — it signs the existing stored artifact as-is,
 * so a package's contents are unchanged.
 *
 * Idempotent: only packages with status=READY, a storagePath, and no
 * signature are touched. Refuses to run in NODE_ENV=production without
 * --allow-prod. Needs PACKAGE_SIGNING_PRIVATE_KEY (it signs).
 *
 * Usage:
 *   pnpm tsx scripts/backfill-package-signatures.ts
 *   pnpm tsx scripts/backfill-package-signatures.ts --allow-prod
 */

import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getObjectStream, getS3Client, getBucket } from '../lib/storage';
import {
  signPackageDigest,
  getPackagePublicKey,
  type PackageSignatureFile,
} from '../lib/package-sig';

async function hashStoredObject(key: string): Promise<Buffer> {
  const stream = await getObjectStream(key);
  const hash = createHash('sha256');
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest();
}

async function main() {
  const allowProd = process.argv.includes('--allow-prod');
  if (process.env.NODE_ENV === 'production' && !allowProd) {
    throw new Error('Refusing to run in production without --allow-prod.');
  }

  const prisma = new PrismaClient();
  try {
    const pkgs = await prisma.evidencePackage.findMany({
      where: { status: 'READY', signature: null, storagePath: { not: null } },
      select: { id: true, storagePath: true },
    });

    let signed = 0;
    for (const pkg of pkgs) {
      const storagePath = pkg.storagePath!;
      const contentHash = await hashStoredObject(storagePath);
      const signedAt = new Date();
      const { signature, signingKeyId } = signPackageDigest(contentHash);

      const sigFile: PackageSignatureFile = {
        packageId: pkg.id,
        algorithm: 'ed25519',
        signingKeyId,
        contentHash: contentHash.toString('hex'),
        signature,
        signedAt: signedAt.toISOString(),
        publicKey: getPackagePublicKey(),
      };
      await getS3Client().send(
        new PutObjectCommand({
          Bucket: getBucket(),
          Key: `${storagePath}.sig`,
          Body: JSON.stringify(sigFile, null, 2),
          ContentType: 'application/json',
        })
      );
      await prisma.evidencePackage.update({
        where: { id: pkg.id },
        data: { contentHash, signature, signingKeyId, signedAt },
      });
      signed += 1;
    }

    // eslint-disable-next-line no-console
    console.log(`package signatures: signed ${signed} previously-unsigned READY package(s)`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
