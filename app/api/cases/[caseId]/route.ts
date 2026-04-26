import { NextResponse, type NextRequest } from 'next/server';
import { z, ZodError } from 'zod';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/guards';
import { errorResponse, ValidationError } from '@/lib/errors';
import { writeAudit } from '@/lib/audit';
import { loadCaseForRead, loadCaseForWrite, caseIsOwner } from '@/lib/case-guards';
import {
  serializeCaseSummary,
  serializePackageSummary,
} from '@/lib/case-serializers';
import { serializeProofSummary } from '@/lib/proof-serializers';

type RouteCtx = { params: { caseId: string } };

/**
 * GET /api/cases/:caseId — case detail.
 *
 * Access: owner OR same-org. Otherwise 404 (don't leak existence).
 *
 * Linked-proof projection:
 *   - owner          → sees every linked proof
 *   - same-org peer  → sees only non-PRIVATE linked proofs, and never sees
 *                      hidden-vault proofs (hidden = never visible to non-owner)
 *
 * Audit: NOT emitted in Phase 4 — owner/org reads are routine. The
 * `case.detail.viewed` action is reserved for a future share mechanism in
 * which a non-owner gains access via an explicit grant. Stub below.
 */
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    const { user } = await requireSession();
    const c = await loadCaseForRead(ctx.params.caseId, user);

    const isOwner = caseIsOwner(c, user);

    // Pull linked proofs through CaseProof. Owner sees everything; org peers
    // get the same ladder /api/proofs uses: non-PRIVATE and not hidden.
    const linkedRows = await prisma.proof.findMany({
      where: {
        caseLinks: { some: { caseId: c.id } },
        ...(isOwner
          ? {}
          : {
              visibility: { not: 'PRIVATE' },
              OR: [
                { preservation: { is: null } },
                { preservation: { is: { hiddenVaultMode: false } } },
              ],
            }),
      },
      orderBy: { createdAt: 'desc' },
    });

    const packages = await prisma.evidencePackage.findMany({
      where: { caseId: c.id },
      orderBy: { createdAt: 'desc' },
    });

    // TODO(phase-share): when non-owner-via-grant access lands, emit
    //   writeAudit({ ..., action: 'case.detail.viewed', meta: { via: 'share' } })
    // here, gated on the access path being a share grant rather than
    // owner/same-org.

    return NextResponse.json({
      case: serializeCaseSummary(c),
      proofs: linkedRows.map(serializeProofSummary),
      packages: packages.map(serializePackageSummary),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

const PatchBody = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(5000).optional(),
    status: z.string().min(1).max(64).optional(),
  })
  .strict();

/**
 * PATCH /api/cases/:caseId — owner-only update.
 *   - missing → 404
 *   - !owner  → 403
 *   - audits case.updated with meta.fields = touched keys (values not logged)
 */
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  try {
    const { user } = await requireSession();
    await loadCaseForWrite(ctx.params.caseId, user);

    const json = await req.json().catch(() => ({}));
    const body = PatchBody.parse(json);

    const fields = Object.keys(body) as Array<keyof typeof body>;
    if (fields.length === 0) {
      throw new ValidationError('No updatable fields provided');
    }

    const updated = await prisma.case.update({
      where: { id: ctx.params.caseId },
      data: {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
      },
      include: {
        proofLinks: { select: { id: true } },
        evidencePackages: { select: { id: true } },
      },
    });

    await writeAudit({
      actorUserId: user.id,
      entityType: 'Case',
      entityId: updated.id,
      action: 'case.updated',
      meta: { fields },
    });

    return NextResponse.json({ case: serializeCaseSummary(updated) });
  } catch (err) {
    if (err instanceof ZodError) {
      return errorResponse(new ValidationError('Invalid request body', err.flatten()));
    }
    return errorResponse(err);
  }
}
