import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/guards';
import { ApiError, errorResponse } from '@/lib/errors';
import { writeAudit } from '@/lib/audit';
import { createNotification } from '@/lib/notifications';
import { loadProofForWrite } from '@/lib/proof-guards';

type RouteCtx = { params: { proofId: string } };

/**
 * Closed set of seal-block reasons. Adding a new reason is a deliberate
 * contract change — do not extend with freeform strings.
 */
export type SealBlockReason =
  | 'missing_title'
  | 'missing_file'
  | 'missing_attestation'
  | 'already_sealed';

class SealRequirementsError extends ApiError {
  constructor(reasons: SealBlockReason[]) {
    super(409, 'SEAL_REQUIREMENTS_NOT_MET', 'Proof cannot be sealed', { reasons });
    this.name = 'SealRequirementsError';
  }
}

/** POST /api/proofs/:proofId/seal — finalize. Owner-only; returns all blockers at once. */
export async function POST(_req: NextRequest, ctx: RouteCtx) {
  try {
    const { user } = await requireSession();
    const proof = await loadProofForWrite(ctx.params.proofId, user);

    const reasons: SealBlockReason[] = [];
    if (proof.status === 'SEALED') reasons.push('already_sealed');
    if (!proof.title || proof.title.trim().length === 0) reasons.push('missing_title');
    if (proof.files.length === 0) reasons.push('missing_file');
    if (!proof.attestation) reasons.push('missing_attestation');

    if (reasons.length > 0) throw new SealRequirementsError(reasons);

    const sealedAt = new Date();
    const sealed = await prisma.proof.update({
      where: { id: proof.id },
      data: { status: 'SEALED', sealedAt },
    });

    await writeAudit({
      actorUserId: user.id,
      entityType: 'Proof',
      entityId: sealed.id,
      action: 'proof.sealed',
      meta: { sealedAt: sealedAt.toISOString() },
    });

    await createNotification({
      userId: sealed.ownerUserId,
      type: 'proof_sealed',
      title: 'Proof sealed',
      body: `"${sealed.title}" has been sealed.`,
      href: `/proofs/${sealed.id}`,
    });

    return NextResponse.json({
      proofId: sealed.id,
      status: 'sealed',
      sealedAt: sealedAt.toISOString(),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
