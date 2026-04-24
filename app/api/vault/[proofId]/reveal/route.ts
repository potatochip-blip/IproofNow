import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireSession } from '@/lib/guards';
import { errorResponse } from '@/lib/errors';
import { writeAudit } from '@/lib/audit';
import { loadProofForWrite } from '@/lib/proof-guards';
import { serializeProof } from '@/lib/proof-serializers';

type RouteCtx = { params: { proofId: string } };

/**
 * Closed set of reveal reasons — frontend picks from a dropdown, so freeform
 * strings would defeat the point of the audit trail. 'other' requires a
 * `reasonText` because the whole point of reveals is deliberate, reviewable
 * intent.
 */
const RevealReason = z.enum(['case_review', 'export_prep', 'user_browse', 'other']);

const RevealBody = z
  .object({
    reason: RevealReason,
    reasonText: z.string().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.reason === 'other' && !val.reasonText) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reasonText'],
        message: 'reasonText is required when reason is "other"',
      });
    }
  });

/**
 * POST /api/vault/:proofId/reveal — owner-initiated, audited hidden-vault
 * reveal. Does NOT flip hiddenVaultMode — it's a one-shot reveal. The
 * frontend needs a single endpoint to fetch a hidden proof's detail (since
 * GET /api/proofs/:id deliberately 404s non-owners and we want a single
 * audited entry point for this action even for owners).
 *
 * 200 → same shape as GET /api/proofs/:id (`{ proof }`).
 * Ownership guarantee: loadProofForWrite returns 403 for non-owners of a
 * visible proof and 404 for a hidden-but-non-owned proof. Either way, a
 * non-owner cannot trigger a reveal.
 */
export async function POST(req: NextRequest, ctx: RouteCtx) {
  try {
    const { user } = await requireSession();
    const json = await req.json().catch(() => ({}));
    const body = RevealBody.parse(json);

    const proof = await loadProofForWrite(ctx.params.proofId, user);

    await writeAudit({
      actorUserId: user.id,
      entityType: 'Proof',
      entityId: proof.id,
      action: 'proof.hidden.revealed',
      meta: {
        reason: body.reason,
        ...(body.reasonText ? { reasonText: body.reasonText } : {}),
        hiddenVaultMode: proof.preservation?.hiddenVaultMode ?? false,
      },
    });

    return NextResponse.json({ proof: await serializeProof(proof) });
  } catch (err) {
    return errorResponse(err);
  }
}
