import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/guards';
import { errorResponse, NotFoundError } from '@/lib/errors';
import { serializePackageSummary } from '@/lib/case-serializers';
import { getPresignedGetUrl } from '@/lib/storage';

type RouteCtx = { params: { packageId: string } };

/**
 * GET /api/packages/:packageId — package detail.
 *
 * Access: package creator OR case owner OR same-org as case.
 *
 * Response: { package, downloadUrl? }. `downloadUrl` is present at the top
 * level only when status=READY AND storagePath is populated. PENDING /
 * FAILED packages omit the field rather than return null — keeps the
 * frontend's "do I have a link?" check a simple `'downloadUrl' in res`.
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

    const body: { package: ReturnType<typeof serializePackageSummary>; downloadUrl?: string } = {
      package: serializePackageSummary(pkg),
    };

    if (pkg.status === 'READY' && pkg.storagePath) {
      body.downloadUrl = await getPresignedGetUrl(pkg.storagePath);
    }

    return NextResponse.json(body);
  } catch (err) {
    return errorResponse(err);
  }
}
