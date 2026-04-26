import { NextResponse, type NextRequest } from 'next/server';
import { z, ZodError } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/guards';
import { errorResponse, ValidationError } from '@/lib/errors';
import { writeAudit } from '@/lib/audit';
import { serializeCaseSummary } from '@/lib/case-serializers';
import { buildCaseSearchFilters } from '@/lib/case-search';

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  orgId: z.string().min(1).optional(),
});

/** POST /api/cases — create a case. Inherits orgId from caller if not given. */
export async function POST(req: NextRequest) {
  try {
    const { user } = await requireSession();
    const json = await req.json().catch(() => ({}));
    const body = CreateBody.parse(json);

    const created = await prisma.case.create({
      data: {
        ownerUserId: user.id,
        orgId: body.orgId ?? user.orgId ?? null,
        title: body.title,
        description: body.description ?? '',
      },
      include: { proofLinks: true, evidencePackages: true },
    });

    await writeAudit({
      actorUserId: user.id,
      entityType: 'Case',
      entityId: created.id,
      action: 'case.created',
      meta: { orgId: created.orgId },
    });

    return NextResponse.json(
      { case: serializeCaseSummary(created) },
      { status: 201 }
    );
  } catch (err) {
    return errorResponse(err);
  }
}

const ListQuery = z.object({
  status: z.string().max(64).optional(),
  scope: z.enum(['owned', 'org']).optional(),
  q: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * GET /api/cases — paginated list.
 *
 * Scoping:
 *   default       → owned cases ∪ same-org cases.
 *   scope=owned   → caller's own cases only.
 *   scope=org     → cases in caller's org (includes own — useful for the
 *                   "all of my team's cases" view).
 *
 * Reuses buildCaseSearchFilters() for q + status; ownership/org scope is
 * composed here so the helper stays route-agnostic.
 */
export async function GET(req: NextRequest) {
  try {
    const { user } = await requireSession();
    const url = new URL(req.url);
    const q = ListQuery.parse(Object.fromEntries(url.searchParams.entries()));

    const filters: Prisma.CaseWhereInput[] = [];

    if (q.scope === 'owned') {
      filters.push({ ownerUserId: user.id });
    } else if (q.scope === 'org') {
      if (!user.orgId) {
        // No org → no org-scoped rows. Short-circuit to an empty page rather
        // than emitting a where that always misses.
        return NextResponse.json({
          cases: [],
          pagination: { page: q.page, pageSize: q.pageSize, total: 0, totalPages: 1 },
        });
      }
      filters.push({ orgId: user.orgId });
    } else {
      const scopeOr: Prisma.CaseWhereInput[] = [{ ownerUserId: user.id }];
      if (user.orgId) scopeOr.push({ orgId: user.orgId });
      filters.push({ OR: scopeOr });
    }

    filters.push(...buildCaseSearchFilters({ q: q.q, status: q.status }));

    const where: Prisma.CaseWhereInput = { AND: filters };

    const [total, rows] = await prisma.$transaction([
      prisma.case.count({ where }),
      prisma.case.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: {
          proofLinks: { select: { id: true } },
          evidencePackages: { select: { id: true } },
        },
      }),
    ]);

    return NextResponse.json({
      cases: rows.map(serializeCaseSummary),
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
