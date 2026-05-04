import archiver from 'archiver';
import { PassThrough } from 'node:stream';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { logger } from '../logger';
import { getObjectStream, getS3Client, getBucket } from '../storage';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { createNotification } from '../notifications';
import type { JobHandler } from '../jobs';

type BuildPackagePayload = { packageId: string };

function isBuildPackagePayload(p: unknown): p is BuildPackagePayload {
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof (p as { packageId?: unknown }).packageId === 'string'
  );
}

/** What goes into manifest.json. Ordered for predictable diffs. */
type Manifest = {
  packageId: string;
  packageType: string;
  caseId: string | null;
  caseTitle: string | null;
  generatedAt: string;
  proofs: Array<{
    id: string;
    title: string;
    sealedAt: string | null;
    files: Array<{
      id: string;
      originalName: string;
      mimeType: string;
      size: number;
      fileHash: string | null;
      archivePath: string;
    }>;
    attestation: {
      attestationName: string;
      attestationLocation: string;
      attestationText: string;
    } | null;
  }>;
};

/**
 * evidence_package.build — assembles a zip with manifest + every file
 * from every linked proof, uploads to S3, flips the package row to
 * READY, and notifies the case owner.
 *
 * Streaming end-to-end:
 *   archiver Pipe → PassThrough → S3 PutObject (Body: stream)
 *   each proof file: getObjectStream → archive.append
 *
 * The archiver emits the central directory once `finalize()` is called;
 * S3's PutObject doesn't see EOF until the PassThrough closes. We `await`
 * both finalize and the SDK send to know the upload is durable before we
 * mark the package READY.
 *
 * Failure semantics:
 *   - mid-zip throw → caller's job-runner retries up to MAX_ATTEMPTS, then
 *     terminal FAILED. We flip the EvidencePackage to FAILED on the
 *     terminal try ourselves, since the runner only owns the Job row.
 */
export const handleBuildPackage: JobHandler = async (payload, ctx) => {
  if (!isBuildPackagePayload(payload)) {
    throw new Error(
      'build-package: invalid payload (expected { packageId: string })'
    );
  }
  const { packageId } = payload;

  const pkg = await prisma.evidencePackage.findUnique({
    where: { id: packageId },
    include: {
      case: {
        include: {
          proofLinks: {
            include: {
              proof: { include: { files: true, attestation: true } },
            },
          },
        },
      },
    },
  });

  if (!pkg) {
    // Package row vanished — terminal no-op.
    logger.warn('build-package.missing', { packageId });
    return;
  }
  if (!pkg.case) {
    await markFailed(packageId, 'Case-less package not supported in Phase 5');
    throw new Error(
      `Package ${packageId} has no caseId — Phase 5 only builds case packages`
    );
  }

  try {
    const storagePath = `packages/${pkg.id}.zip`;
    await streamZipToS3(pkg, storagePath);

    await prisma.evidencePackage.update({
      where: { id: pkg.id },
      data: { status: 'READY', storagePath },
    });

    await createNotification({
      userId: pkg.case.ownerUserId,
      type: 'evidence_package_ready',
      title: 'Evidence package ready',
      body: `Your ${pkg.packageType.replace('_', ' ')} package for "${pkg.case.title}" is ready to download.`,
      href: `/cases/${pkg.case.id}`,
    });
  } catch (err) {
    // Only flip EvidencePackage to FAILED on the terminal attempt — earlier
    // attempts retry, and we don't want the row toggling READY/FAILED on
    // every retry. ctx.attempts is post-increment from the runner, so the
    // 3rd (final) try has attempts === 3 in our default policy.
    const isTerminal = ctx.attempts >= 3;
    if (isTerminal) {
      await markFailed(
        pkg.id,
        err instanceof Error ? err.message : String(err)
      );
    }
    throw err;
  }
};

async function markFailed(packageId: string, reason: string): Promise<void> {
  await prisma.evidencePackage.update({
    where: { id: packageId },
    data: { status: 'FAILED' },
  });
  logger.error('build-package.failed', { packageId, reason });
}

type LoadedPackage = Prisma.EvidencePackageGetPayload<{
  include: {
    case: {
      include: {
        proofLinks: {
          include: { proof: { include: { files: true; attestation: true } } };
        };
      };
    };
  };
}>;

async function streamZipToS3(
  pkg: LoadedPackage,
  storagePath: string
): Promise<void> {
  if (!pkg.case) throw new Error('streamZipToS3: package has no case');

  const archive = archiver('zip', { zlib: { level: 6 } });
  const passthrough = new PassThrough();

  // Wire the streams up before we start appending — otherwise the first
  // entry races the consumer.
  archive.pipe(passthrough);

  // Capture upload promise without awaiting yet; we need to feed entries
  // first, then finalize, then await both.
  const uploadPromise = getS3Client().send(
    new PutObjectCommand({
      Bucket: getBucket(),
      Key: storagePath,
      Body: passthrough,
      ContentType: 'application/zip',
    })
  );

  const archiveErrPromise = new Promise<never>((_resolve, reject) => {
    archive.on('error', reject);
  });

  const manifest: Manifest = {
    packageId: pkg.id,
    packageType: pkg.packageType,
    caseId: pkg.case.id,
    caseTitle: pkg.case.title,
    generatedAt: new Date().toISOString(),
    proofs: [],
  };

  for (const link of pkg.case.proofLinks) {
    const proof = link.proof;
    const proofManifest: Manifest['proofs'][number] = {
      id: proof.id,
      title: proof.title,
      sealedAt: proof.sealedAt?.toISOString() ?? null,
      files: [],
      attestation: proof.attestation
        ? {
            attestationName: proof.attestation.attestationName,
            attestationLocation: proof.attestation.attestationLocation,
            attestationText: proof.attestation.attestationText,
          }
        : null,
    };

    for (const file of proof.files) {
      // Use proof id + file id in the path so duplicate originalNames
      // across proofs don't collide.
      const archivePath = `proofs/${proof.id}/${file.id}-${sanitizeName(file.originalName)}`;
      proofManifest.files.push({
        id: file.id,
        originalName: file.originalName,
        mimeType: file.mimeType,
        size: file.size,
        fileHash: file.fileHash,
        archivePath,
      });

      const stream = await getObjectStream(file.storagePath);
      archive.append(stream, { name: archivePath });
    }

    manifest.proofs.push(proofManifest);
  }

  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

  // Race finalize against archive errors so we surface stream failures
  // rather than hang the upload promise.
  await Promise.race([archive.finalize(), archiveErrPromise]);
  await uploadPromise;
}

/** Strip path separators + control chars so an attacker-controlled
 *  originalName can't escape its archive directory. */
function sanitizeName(name: string): string {
  return name.replace(/[\x00-\x1f/\\]/g, '_').slice(0, 200) || 'file';
}
