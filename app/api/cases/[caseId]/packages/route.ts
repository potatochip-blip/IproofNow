import { NextResponse, type NextRequest } from 'next/server';
import { z, ZodError } from 'zod';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/guards';
import { errorResponse, ForbiddenError, ValidationError } from '@/lib/errors';
import { writeAudit } from '@/lib/audit';
import { createNotification } from '@/lib/notifications';
import { loadCaseForRead, caseIsOwner, caseIsSameOrg } from '@/lib/case-guards';
import { serializePackageSummary } from '@/lib/case-serializers';

type RouteCtx = { params: { caseId: string } };

const RequestBody = z.object({
  packageType: z.enum(['court_bundle', 'discovery', 'custom']),
});

/**
 * POST /api/cases/:caseId/packages — request an evidence package.
 *
 * Access:
 *   - case owner, OR
 *   - same-org AND role ∈ { LAWYER, LAW_ENFORCEMENT }
 *
 * Phase 4 stub: synchronously writes a row with status=PENDING and returns
 * 202. The actual zip-assembly worker lands in Phase 5 — do NOT try to
 * stream files or sign URLs here.
 *
 * Side effects (fire-and-log):
 *   - audit `package.requested` with packageType + packageId
 *   - notification `evidence_package_requested` to the case owner
 */
export async function POST(req: NextRequest, ctx: RouteCtx) {
  try {
    const { user } = await requireSession();
    const c = await loadCaseForRead(ctx.params.caseId, user);

    const isOwner = caseIsOwner(c, user);
    const isCounsel =
      caseIsSameOrg(c, user) &&
      (user.role === 'LAWYER' || user.role === 'LAW_ENFORCEMENT');
    if (!isOwner && !isCounsel) {
      throw new ForbiddenError('Not permitted to request packages on this case');
    }

    const json = await req.json().catch(() => ({}));
    const body = RequestBody.parse(json);

    const pkg = await prisma.evidencePackage.create({
      data: {
        caseId: c.id,
        packageType: body.packageType,
        createdByUserId: user.id,
        // status PENDING via schema default; storagePath stays null until
        // the Phase 5 worker writes the zip.
      },
    });

    await writeAudit({
      actorUserId: user.id,
      entityType: 'EvidencePackage',
      entityId: pkg.id,
      action: 'package.requested',
      meta: { packageType: body.packageType, caseId: c.id },
    });

    await createNotification({
      userId: c.ownerUserId,
      type: 'evidence_package_requested',
      title: 'Evidence package requested',
      body: `A ${body.packageType.replace('_', ' ')} package was requested for "${c.title}".`,
      href: `/cases/${c.id}`,
    });

    return NextResponse.json(
      { packageId: pkg.id, status: 'pending' },
      { status: 202 }
    );
  } catch (err) {
    if (err instanceof ZodError) {
      return errorResponse(new ValidationError('Invalid request body', err.flatten()));
    }
    return errorResponse(err);
  }
}

/**
 * GET /api/cases/:caseId/packages — list packages for a case.
 *
 * Access: same as case detail (owner OR same-org).
 */
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    const { user } = await requireSession();
    const c = await loadCaseForRead(ctx.params.caseId, user);

    const packages = await prisma.evidencePackage.findMany({
      where: { caseId: c.id },
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json({
      packages: packages.map(serializePackageSummary),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
