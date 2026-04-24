import { NextResponse, type NextRequest } from 'next/server';
import { z, ZodError } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/guards';
import { errorResponse, ValidationError } from '@/lib/errors';
import { writeAudit } from '@/lib/audit';
import { serializeProof, serializeProofSummary } from '@/lib/proof-serializers';

const CreateBody = z.object({
  proofType: z.string().min(1).max(64),
  categoryKey: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  roleContext: z.string().max(200).optional(),
});

/** POST /api/proofs — create a draft proof. */
export async function POST(req: NextRequest) {
  try {
    const { user } = await requireSession();
    const json = await req.json().catch(() => ({}));
    const body = CreateBody.parse(json);

    const created = await prisma.proof.create({
      data: {
        ownerUserId: user.id,
        orgId: user.orgId ?? null,
        title: body.title,
        description: body.description ?? '',
        categoryKey: body.categoryKey,
        proofType: body.proofType,
        roleContext: body.roleContext ?? null,
        // status DRAFT, visibility PRIVATE via schema defaults.
      },
      include: { files: true, attestation: true, preservation: true },
    });

    await writeAudit({
      actorUserId: user.id,
      entityType: 'Proof',
      entityId: created.id,
      action: 'proof.created',
      meta: {
        proofType: created.proofType,
        categoryKey: created.categoryKey,
      },
    });

    return NextResponse.json({ proof: await serializeProof(created) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

const ListQuery = z.object({
  status: z.enum(['DRAFT', 'SEALED']).optional(),
  category: z.string().max(64).optional(),
  scope: z.enum(['hidden']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * GET /api/proofs — paginated list.
 *
 * Scoping:
 *   default       → caller's own proofs + same-org non-private proofs.
 *                   Hidden-vault proofs are excluded unconditionally.
 *   scope=hidden  → caller's own hidden-vault proofs only. Audited as a
 *                   sensitive read (`proof.hidden.listed`). An authenticated
 *                   caller with no hidden proofs correctly receives an empty
 *                   page — the endpoint is self-scoped, so a non-owner has
 *                   no way to enumerate someone else's hidden vault via it.
 */
export async function GET(req: NextRequest) {
  try {
    const { user } = await requireSession();
    const url = new URL(req.url);
    const q = ListQuery.parse(Object.fromEntries(url.searchParams.entries()));

    const filters: Prisma.ProofWhereInput[] = [];

    if (q.scope === 'hidden') {
      filters.push({
        ownerUserId: user.id,
        preservation: { is: { hiddenVaultMode: true } },
      });
    } else {
      const scopeOr: Prisma.ProofWhereInput[] = [{ ownerUserId: user.id }];
      if (user.orgId) {
        scopeOr.push({ orgId: user.orgId, visibility: { not: 'PRIVATE' } });
      }
      filters.push({ OR: scopeOr });
      filters.push({
        OR: [
          { preservation: { is: null } },
          { preservation: { is: { hiddenVaultMode: false } } },
        ],
      });
    }

    if (q.status) filters.push({ status: q.status });
    if (q.category) filters.push({ categoryKey: q.category });

    const where: Prisma.ProofWhereInput = { AND: filters };

    const [total, rows] = await prisma.$transaction([
      prisma.proof.count({ where }),
      prisma.proof.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);

    if (q.scope === 'hidden') {
      await writeAudit({
        actorUserId: user.id,
        entityType: 'User',
        entityId: user.id,
        action: 'proof.hidden.listed',
        meta: { count: rows.length, page: q.page, pageSize: q.pageSize },
      });
    }

    return NextResponse.json({
      proofs: rows.map(serializeProofSummary),
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
