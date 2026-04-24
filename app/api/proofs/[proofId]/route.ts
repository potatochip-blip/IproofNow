import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/guards';
import { errorResponse } from '@/lib/errors';
import { writeAudit } from '@/lib/audit';
import { assertNotSealed, loadProofForRead, loadProofForWrite } from '@/lib/proof-guards';
import { serializeProof } from '@/lib/proof-serializers';

type RouteCtx = { params: { proofId: string } };

/** GET /api/proofs/:proofId — full detail. */
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    const { user } = await requireSession();
    const proof = await loadProofForRead(ctx.params.proofId, user);
    return NextResponse.json({ proof: await serializeProof(proof) });
  } catch (err) {
    return errorResponse(err);
  }
}

const UpdateBody = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(5000).optional(),
    eventDate: z.string().datetime().nullable().optional(),
    peopleInvolved: z.array(z.string().max(200)).max(100).optional(),
    notes: z.string().max(10_000).nullable().optional(),
    visibility: z.enum(['PRIVATE', 'PUBLIC', 'ORG']).optional(),
    locationMode: z.string().max(64).nullable().optional(),
    manualLocation: z.string().max(500).nullable().optional(),
    preservationMode: z.boolean().optional(),
    hiddenVaultMode: z.boolean().optional(),
  })
  .strict();

/** PATCH /api/proofs/:proofId — update draft metadata. Owner-only; 409 if sealed. */
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  try {
    const { user } = await requireSession();
    const existing = await loadProofForWrite(ctx.params.proofId, user);
    assertNotSealed(existing);

    const json = await req.json().catch(() => ({}));
    const body = UpdateBody.parse(json);

    const proofData: Record<string, unknown> = {};
    if (body.title !== undefined) proofData.title = body.title;
    if (body.description !== undefined) proofData.description = body.description;
    if (body.eventDate !== undefined) {
      proofData.eventDate = body.eventDate === null ? null : new Date(body.eventDate);
    }
    if (body.peopleInvolved !== undefined) proofData.peopleInvolved = body.peopleInvolved;
    if (body.notes !== undefined) proofData.notes = body.notes;
    if (body.visibility !== undefined) proofData.visibility = body.visibility;
    if (body.locationMode !== undefined) proofData.locationMode = body.locationMode;
    if (body.manualLocation !== undefined) proofData.manualLocation = body.manualLocation;

    const preservationChanged =
      body.preservationMode !== undefined || body.hiddenVaultMode !== undefined;

    await prisma.$transaction(async (tx) => {
      if (Object.keys(proofData).length > 0) {
        await tx.proof.update({ where: { id: existing.id }, data: proofData });
      }
      if (preservationChanged) {
        await tx.preservationConfig.upsert({
          where: { proofId: existing.id },
          create: {
            proofId: existing.id,
            preservationMode: body.preservationMode ?? false,
            hiddenVaultMode: body.hiddenVaultMode ?? false,
          },
          update: {
            ...(body.preservationMode !== undefined
              ? { preservationMode: body.preservationMode }
              : {}),
            ...(body.hiddenVaultMode !== undefined
              ? { hiddenVaultMode: body.hiddenVaultMode }
              : {}),
          },
        });
      }
    });

    const fresh = await prisma.proof.findUniqueOrThrow({
      where: { id: existing.id },
      include: { files: true, attestation: true, preservation: true },
    });

    await writeAudit({
      actorUserId: user.id,
      entityType: 'Proof',
      entityId: fresh.id,
      action: 'proof.updated',
      meta: { fields: Object.keys(body) },
    });

    return NextResponse.json({ proof: await serializeProof(fresh) });
  } catch (err) {
    return errorResponse(err);
  }
}
