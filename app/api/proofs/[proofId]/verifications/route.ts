import { NextResponse, type NextRequest } from 'next/server';
import { z, ZodError } from 'zod';
import type { VerificationResult, VerificationTier } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getCurrentSession } from '@/lib/guards';
import { errorResponse, ValidationError } from '@/lib/errors';
import { loadProofForVerify } from '@/lib/proof-guards';

type RouteCtx = { params: { proofId: string } };

const ListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

type VerificationSummary = {
  id: string;
  method: string;
  result: VerificationResult;
  tier: VerificationTier | null;
  createdAt: string;
};

/**
 * GET /api/proofs/:proofId/verifications — verification history for a proof.
 *
 * Same access rules as /verify: PUBLIC is readable without session; PRIVATE
 * / ORG require read access; hidden proofs 404 to non-owners.
 *
 * Phase 8: `counts` covers every VerificationResult enum value, and a
 * `tiers` breakdown reports how many VERIFIED results reached each strength
 * tier. No audit — aggregate metadata; the proof access check already gates
 * anything sensitive.
 */
export async function GET(req: NextRequest, ctx: RouteCtx) {
  try {
    const session = await getCurrentSession();
    const actor = session?.user ?? null;

    const url = new URL(req.url);
    const q = ListQuery.parse(Object.fromEntries(url.searchParams.entries()));

    const proof = await loadProofForVerify(ctx.params.proofId, actor);

    const where = { proofId: proof.id };

    const [total, rows, byResult, byTier] = await prisma.$transaction([
      prisma.verificationRecord.count({ where }),
      prisma.verificationRecord.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: { id: true, method: true, result: true, tier: true, createdAt: true },
      }),
      prisma.verificationRecord.groupBy({
        by: ['result'],
        where,
        _count: true,
        orderBy: { result: 'asc' },
      }),
      prisma.verificationRecord.groupBy({
        by: ['tier'],
        where,
        _count: true,
        orderBy: { tier: 'asc' },
      }),
    ]);

    const counts = { verified: 0, tampered: 0, notFound: 0, indeterminate: 0 };
    for (const g of byResult) {
      // _count is a number when groupBy is called with `_count: true`, but
      // Prisma's generic typing surfaces it as a union — coerce explicitly.
      const n = g._count as number;
      if (g.result === 'VERIFIED') counts.verified = n;
      else if (g.result === 'TAMPERED') counts.tampered = n;
      else if (g.result === 'NOT_FOUND') counts.notFound = n;
      else if (g.result === 'INDETERMINATE') counts.indeterminate = n;
    }

    const tiers = { hashVerified: 0, cryptographicallyVerified: 0 };
    for (const g of byTier) {
      const n = g._count as number;
      if (g.tier === 'HASH_VERIFIED') tiers.hashVerified = n;
      else if (g.tier === 'CRYPTOGRAPHICALLY_VERIFIED') tiers.cryptographicallyVerified = n;
      // g.tier === null is the non-VERIFIED bucket — not a tier, skipped.
    }

    const verifications: VerificationSummary[] = rows.map((r) => ({
      id: r.id,
      method: r.method,
      result: r.result,
      tier: r.tier,
      createdAt: r.createdAt.toISOString(),
    }));

    return NextResponse.json({
      verifications,
      counts,
      tiers,
      pagination: {
        page: q.page,
        pageSize: q.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
      },
    });
  } catch (err) {
    if (err instanceof ZodError) {
      return errorResponse(new ValidationError('Invalid query parameters', err.flatten()));
    }
    return errorResponse(err);
  }
}
