import { NextResponse, type NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/guards';
import { errorResponse, NotFoundError } from '@/lib/errors';
import { writeAudit } from '@/lib/audit';
import { getObjectStream, getPresignedGetUrl } from '@/lib/storage';
import { verifyPackageSignature } from '@/lib/package-sig';

type RouteCtx = { params: { packageId: string } };

/** sha256 the stored object by streaming it — never buffers the whole zip. */
async function hashStoredObject(key: string): Promise<Buffer> {
  const stream = await getObjectStream(key);
  const hash = createHash('sha256');
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest();
}

/**
 * GET /api/packages/:packageId/verify — verify an evidence package's
 * detached ed25519 signature.
 *
 * Access: package creator OR case owner OR same-org as case (mirrors the
 * package detail route; otherwise 404 — existence not leaked).
 *
 * Re-hashes the stored .zip and checks it against the signed digest, and
 * verifies the ed25519 signature over that digest:
 *   - `digestMatches`  — the stored zip still hashes to the signed digest
 *     (catches a swapped S3 object).
 *   - `signatureValid` — the signature is a valid ed25519 signature over
 *     the recorded contentHash (catches a tampered DB row).
 * Both true ⇒ the package is authentic and intact.
 *
 * Legacy / non-READY / unsigned packages return `{ signed: false }`.
 * Audits `package.verified`.
 */
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    const { user } = await requireSession();

    const pkg = await prisma.evidencePackage.findUnique({
      where: { id: ctx.params.packageId },
      include: { case: true },
    });
    if (!pkg) throw new NotFoundError('Package not found');

    const isCreator = pkg.createdByUserId === user.id;
    const isCaseOwner = pkg.case ? pkg.case.ownerUserId === user.id : false;
    const isSameOrg =
      pkg.case && pkg.case.orgId && user.orgId && pkg.case.orgId === user.orgId;
    if (!isCreator && !isCaseOwner && !isSameOrg) {
      throw new NotFoundError('Package not found');
    }

    // Nothing to verify: not READY, or built before Phase 9 (unsigned).
    const isSigned =
      pkg.status === 'READY' &&
      pkg.storagePath !== null &&
      pkg.signature !== null &&
      pkg.contentHash !== null;

    if (!isSigned) {
      await writeAudit({
        actorUserId: user.id,
        entityType: 'EvidencePackage',
        entityId: pkg.id,
        action: 'package.verified',
        meta: { signed: false, signatureValid: false, digestMatches: false },
      });
      return NextResponse.json({ signed: false });
    }

    const storedDigest = Buffer.from(pkg.contentHash!);
    const liveDigest = await hashStoredObject(pkg.storagePath!);
    const digestMatches = liveDigest.equals(storedDigest);
    const signatureValid = verifyPackageSignature(storedDigest, pkg.signature!);

    await writeAudit({
      actorUserId: user.id,
      entityType: 'EvidencePackage',
      entityId: pkg.id,
      action: 'package.verified',
      meta: { signed: true, signatureValid, digestMatches },
    });

    return NextResponse.json({
      signed: true,
      signatureValid,
      digestMatches,
      signingKeyId: pkg.signingKeyId,
      signedAt: pkg.signedAt?.toISOString() ?? null,
      // The detached .sig sidecar — lets the caller run scripts/verify-package.ts
      // fully offline (download the .zip + this .sig, no iProofNow needed).
      signatureUrl: await getPresignedGetUrl(`${pkg.storagePath}.sig`),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
