import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/guards';
import { errorResponse, ValidationError } from '@/lib/errors';
import { writeAudit } from '@/lib/audit';
import { assertNotSealed, loadProofForWrite } from '@/lib/proof-guards';
import { serializeAttestation } from '@/lib/proof-serializers';

type RouteCtx = { params: { proofId: string } };

const AttestBody = z
  .object({
    attestationName: z.string().min(1).max(200),
    attestationLocation: z.string().min(1).max(200),
    attestationText: z.string().min(1).max(10_000),
    attestationFileId: z.string().min(1).max(64).nullable().optional(),
  })
  .strict();

/** POST /api/proofs/:proofId/attestation — create or update. Owner-only; 409 if sealed. */
export async function POST(req: NextRequest, ctx: RouteCtx) {
  try {
    const { user } = await requireSession();
    const proof = await loadProofForWrite(ctx.params.proofId, user);
    assertNotSealed(proof);

    const json = await req.json().catch(() => ({}));
    const body = AttestBody.parse(json);

    // If caller supplied attestationFileId, it must be a file that belongs
    // to this proof. Otherwise we'd let proofs cross-reference files they
    // don't own.
    if (body.attestationFileId) {
      const file = await prisma.proofFile.findUnique({
        where: { id: body.attestationFileId },
        select: { proofId: true },
      });
      if (!file || file.proofId !== proof.id) {
        throw new ValidationError('attestationFileId does not belong to this proof');
      }
    }

    const attestation = await prisma.proofAttestation.upsert({
      where: { proofId: proof.id },
      create: {
        proofId: proof.id,
        attestationName: body.attestationName,
        attestationLocation: body.attestationLocation,
        attestationText: body.attestationText,
        attestationFileId: body.attestationFileId ?? null,
      },
      update: {
        attestationName: body.attestationName,
        attestationLocation: body.attestationLocation,
        attestationText: body.attestationText,
        attestationFileId: body.attestationFileId ?? null,
      },
    });

    await writeAudit({
      actorUserId: user.id,
      entityType: 'Proof',
      entityId: proof.id,
      action: 'proof.attestation.saved',
      meta: { attestationId: attestation.id },
    });

    return NextResponse.json({ attestation: serializeAttestation(attestation) });
  } catch (err) {
    return errorResponse(err);
  }
}
