import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getCurrentSession } from '@/lib/guards';
import { errorResponse } from '@/lib/errors';
import { writeAudit } from '@/lib/audit';
import { loadProofForVerify } from '@/lib/proof-guards';

type RouteCtx = { params: { proofId: string } };

const VerifyBody = z
  .object({
    method: z.enum(['hash', 'qr', 'link']),
    context: z.record(z.unknown()).optional(),
  })
  .strict();

/**
 * POST /api/proofs/:proofId/verify — record a verification attempt.
 *
 * Access:
 *   - PUBLIC visibility          → no session required.
 *   - PRIVATE / ORG visibility   → session + owner or same-org-non-private.
 *   - Hidden vault               → 404 to everyone except owner (invariant).
 *
 * Phase 3 always returns result='verified' if access resolves — real hash
 * comparison is Phase 6. The VerificationRecord row is created either way
 * so future phases can rewrite the pass/fail logic without touching the
 * client contract.
 */
export async function POST(req: NextRequest, ctx: RouteCtx) {
  try {
    const session = await getCurrentSession();
    const actor = session?.user ?? null;

    const json = await req.json().catch(() => ({}));
    const body = VerifyBody.parse(json);

    const proof = await loadProofForVerify(ctx.params.proofId, actor);

    const record = await prisma.verificationRecord.create({
      data: {
        proofId: proof.id,
        method: body.method,
        result: 'verified',
        requesterContext: (body.context ?? {}) as object,
      },
    });

    await writeAudit({
      actorUserId: actor?.id ?? null,
      entityType: 'Proof',
      entityId: proof.id,
      action: 'proof.verified',
      meta: {
        method: body.method,
        result: 'verified',
        visibility: proof.visibility,
        anonymous: actor === null,
      },
    });

    return NextResponse.json({
      verificationId: record.id,
      proofId: proof.id,
      result: record.result,
      verifiedAt: record.createdAt.toISOString(),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
