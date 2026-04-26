import { NextResponse, type NextRequest } from 'next/server';
import { z, ZodError } from 'zod';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/guards';
import { errorResponse, ForbiddenError, ValidationError } from '@/lib/errors';
import { writeAudit } from '@/lib/audit';
import { loadCaseForWrite } from '@/lib/case-guards';

type RouteCtx = { params: { caseId: string } };

const LinkBody = z.object({
  proofIds: z.array(z.string().min(1)).min(1).max(100),
});

/**
 * POST /api/cases/:caseId/proofs — link proofs to a case.
 *
 * Auth: caller must own the case AND own every proof in proofIds.
 * Atomicity: pre-validates ownership of every proof inside a transaction;
 * if any fails, the entire batch rolls back — no partial links, no audit
 * rows.
 *
 * Idempotency: existing (caseId, proofId) pairs are skipped via the unique
 * constraint. Audits fire only for newly-created links (skipped duplicates
 * are not re-audited).
 *
 * Response: 201 → { linked: number } where number is the count of newly-
 * created links.
 */
export async function POST(req: NextRequest, ctx: RouteCtx) {
  try {
    const { user } = await requireSession();
    await loadCaseForWrite(ctx.params.caseId, user);

    const json = await req.json().catch(() => ({}));
    const body = LinkBody.parse(json);

    // De-dupe in-payload before going to the DB.
    const requestedIds = Array.from(new Set(body.proofIds));

    const newLinks = await prisma.$transaction(async (tx) => {
      const proofs = await tx.proof.findMany({
        where: { id: { in: requestedIds } },
        select: { id: true, ownerUserId: true },
      });

      // Atomic ownership check: every requested ID must exist AND belong to
      // the caller. Even one foreign / missing ID rolls back the whole batch.
      if (proofs.length !== requestedIds.length) {
        throw new ForbiddenError('One or more proofs not linkable by caller');
      }
      if (proofs.some((p) => p.ownerUserId !== user.id)) {
        throw new ForbiddenError('One or more proofs not linkable by caller');
      }

      const existing = await tx.caseProof.findMany({
        where: { caseId: ctx.params.caseId, proofId: { in: requestedIds } },
        select: { proofId: true },
      });
      const existingSet = new Set(existing.map((e) => e.proofId));
      const toCreate = requestedIds.filter((id) => !existingSet.has(id));

      if (toCreate.length > 0) {
        await tx.caseProof.createMany({
          data: toCreate.map((proofId) => ({
            caseId: ctx.params.caseId,
            proofId,
          })),
          skipDuplicates: true,
        });
      }

      return toCreate;
    });

    // Audit outside the transaction — fire-and-log, must not affect the
    // user-visible response on a transient failure.
    for (const proofId of newLinks) {
      await writeAudit({
        actorUserId: user.id,
        entityType: 'Case',
        entityId: ctx.params.caseId,
        action: 'case.proof.linked',
        meta: { proofId },
      });
    }

    return NextResponse.json({ linked: newLinks.length }, { status: 201 });
  } catch (err) {
    if (err instanceof ZodError) {
      return errorResponse(new ValidationError('Invalid request body', err.flatten()));
    }
    return errorResponse(err);
  }
}
