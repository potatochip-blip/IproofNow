import { NextResponse, type NextRequest } from 'next/server';
import { z, ZodError } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/guards';
import { errorResponse, ValidationError } from '@/lib/errors';
import { writeAudit } from '@/lib/audit';
import {
  buildProofSearchFilters,
  buildProofOrderBy,
  type ProofSortBy,
  type ProofSortDir,
} from '@/lib/proof-search';
import {
  proofStatusToFrontend,
  visibilityToFrontend,
  type FrontendProofStatus,
  type FrontendVisibility,
} from '@/lib/proof-serializers';

/**
 * GET /api/vault — owner-scoped proof browser with richer filtering and
 * completion badges than /api/proofs.
 *
 * Scope: the caller's own proofs ONLY (no org). This is intentional — vault
 * is the owner's private staging / archive surface; cross-org browsing
 * belongs on /api/proofs.
 *
 * Hidden vault: excluded by default; ?scope=hidden narrows to owner's
 * hidden proofs only and emits `proof.hidden.listed` (sensitive read, same
 * action Phase 2 /api/proofs uses).
 *
 * Row shape carries `hasFiles` + `hasAttestation` so the UI can render
 * completion badges without fetching detail per row.
 */

const ListQuery = z.object({
  q: z.string().max(200).optional(),
  proofType: z.string().max(64).optional(),
  category: z.string().max(64).optional(),
  status: z.enum(['DRAFT', 'SEALED']).optional(),
  visibility: z.enum(['PRIVATE', 'PUBLIC', 'ORG']).optional(),
  scope: z.enum(['hidden']).optional(),
  sortBy: z.enum(['createdAt', 'sealedAt', 'title']).default('createdAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

type VaultRow = {
  id: string;
  title: string;
  status: FrontendProofStatus;
  category: string;
  proofType: string;
  visibility: FrontendVisibility;
  createdAt: string;
  sealedAt: string | null;
  hasFiles: boolean;
  hasAttestation: boolean;
};

export async function GET(req: NextRequest) {
  try {
    const { user } = await requireSession();
    const url = new URL(req.url);
    const q = ListQuery.parse(Object.fromEntries(url.searchParams.entries()));

    const filters: Prisma.ProofWhereInput[] = [
      { ownerUserId: user.id },
    ];

    if (q.scope === 'hidden') {
      filters.push({ preservation: { is: { hiddenVaultMode: true } } });
    } else {
      filters.push({
        OR: [
          { preservation: { is: null } },
          { preservation: { is: { hiddenVaultMode: false } } },
        ],
      });
    }

    filters.push(...buildProofSearchFilters({
      q: q.q,
      proofType: q.proofType,
      category: q.category,
      status: q.status,
      visibility: q.visibility,
    }));

    const where: Prisma.ProofWhereInput = { AND: filters };
    const orderBy = buildProofOrderBy(q.sortBy as ProofSortBy, q.sortDir as ProofSortDir);

    const [total, rows] = await prisma.$transaction([
      prisma.proof.count({ where }),
      prisma.proof.findMany({
        where,
        orderBy,
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: {
          id: true,
          title: true,
          status: true,
          categoryKey: true,
          proofType: true,
          visibility: true,
          createdAt: true,
          sealedAt: true,
          files: { select: { id: true }, take: 1 },
          attestation: { select: { id: true } },
        },
      }),
    ]);

    if (q.scope === 'hidden') {
      await writeAudit({
        actorUserId: user.id,
        entityType: 'User',
        entityId: user.id,
        action: 'proof.hidden.listed',
        meta: { via: 'vault', count: rows.length, page: q.page, pageSize: q.pageSize },
      });
    }

    const proofs: VaultRow[] = rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: proofStatusToFrontend(r.status),
      category: r.categoryKey,
      proofType: r.proofType,
      visibility: visibilityToFrontend(r.visibility),
      createdAt: r.createdAt.toISOString(),
      sealedAt: r.sealedAt?.toISOString() ?? null,
      hasFiles: r.files.length > 0,
      hasAttestation: r.attestation !== null,
    }));

    return NextResponse.json({
      proofs,
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
