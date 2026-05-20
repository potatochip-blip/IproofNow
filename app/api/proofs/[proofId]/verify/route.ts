import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getCurrentSession } from '@/lib/guards';
import { errorResponse } from '@/lib/errors';
import { writeAudit } from '@/lib/audit';
import { loadProofForVerify } from '@/lib/proof-guards';
import { appendVerificationRecord } from '@/lib/verification-chain';
import { evaluateProof } from '@/lib/proof-verification';

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
 * Phase 8: the result is real. `evaluateProof` recomputes the proof's
 * content digest and compares it to ProofAnchor.contentHash, yielding
 * VERIFIED / TAMPERED / NOT_FOUND / INDETERMINATE plus a strength tier.
 * The VerificationRecord is appended to the per-proof hash chain either
 * way, and `proof.verified` is always audited — including for anonymous
 * verifies of PUBLIC proofs, so a TAMPERED finding is never silent.
 */
export async function POST(req: NextRequest, ctx: RouteCtx) {
  try {
    const session = await getCurrentSession();
    const actor = session?.user ?? null;

    const json = await req.json().catch(() => ({}));
    const body = VerifyBody.parse(json);

    const proof = await loadProofForVerify(ctx.params.proofId, actor);

    const { result, tier } = await evaluateProof(proof);

    const record = await appendVerificationRecord({
      proofId: proof.id,
      method: body.method,
      result,
      tier,
      requesterContext: body.context,
    });

    await writeAudit({
      actorUserId: actor?.id ?? null,
      entityType: 'Proof',
      entityId: proof.id,
      action: 'proof.verified',
      meta: {
        method: body.method,
        result,
        tier,
        visibility: proof.visibility,
        anonymous: actor === null,
      },
    });

    return NextResponse.json({
      verificationId: record.id,
      proofId: proof.id,
      result: record.result,
      tier: record.tier,
      verifiedAt: record.createdAt.toISOString(),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
