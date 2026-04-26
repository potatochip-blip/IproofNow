import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/guards';
import { errorResponse, NotFoundError } from '@/lib/errors';
import { writeAudit } from '@/lib/audit';
import { loadCaseForWrite } from '@/lib/case-guards';

type RouteCtx = { params: { caseId: string; proofId: string } };

/**
 * DELETE /api/cases/:caseId/proofs/:proofId — unlink a proof.
 *
 * Auth: case owner only (loadCaseForWrite). Missing case → 404; non-owner
 * → 403. Missing CaseProof row (already unlinked or never linked) → 404.
 *
 * Audits case.proof.unlinked once per call.
 */
export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  try {
    const { user } = await requireSession();
    await loadCaseForWrite(ctx.params.caseId, user);

    const link = await prisma.caseProof.findUnique({
      where: {
        caseId_proofId: { caseId: ctx.params.caseId, proofId: ctx.params.proofId },
      },
    });
    if (!link) throw new NotFoundError('Link not found');

    await prisma.caseProof.delete({ where: { id: link.id } });

    await writeAudit({
      actorUserId: user.id,
      entityType: 'Case',
      entityId: ctx.params.caseId,
      action: 'case.proof.unlinked',
      meta: { proofId: ctx.params.proofId },
    });

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
