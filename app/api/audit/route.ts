import { NextResponse, type NextRequest } from 'next/server';
import { z, ZodError } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/guards';
import { errorResponse, ValidationError } from '@/lib/errors';
import { writeAudit } from '@/lib/audit';

const ListQuery = z.object({
  action: z.string().max(128).optional(),
  entityType: z.string().max(64).optional(),
  entityId: z.string().max(64).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

type AuditSummary = {
  id: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  meta: unknown;
  createdAt: string;
};

/**
 * GET /api/audit — actor-scoped audit query.
 *
 * Scope:
 *   - Non-admin → rows where actorUserId === session user (users see their
 *     own trail only).
 *   - ADMIN     → unscoped (sees every actor's rows).
 *
 * Audits itself as `audit.queried` (sensitive read). Meta carries the
 * filter keys that were set on this query so downstream reviewers can see
 * whether a broad sweep or a narrow lookup happened — not the values,
 * which could themselves be sensitive.
 */
export async function GET(req: NextRequest) {
  try {
    const { user } = await requireSession();
    const url = new URL(req.url);
    const q = ListQuery.parse(Object.fromEntries(url.searchParams.entries()));

    const filters: Prisma.AuditLogWhereInput[] = [];
    if (user.role !== 'ADMIN') {
      filters.push({ actorUserId: user.id });
    }
    if (q.action) filters.push({ action: q.action });
    if (q.entityType) filters.push({ entityType: q.entityType });
    if (q.entityId) filters.push({ entityId: q.entityId });
    if (q.since || q.until) {
      const range: Prisma.DateTimeFilter = {};
      if (q.since) range.gte = new Date(q.since);
      if (q.until) range.lte = new Date(q.until);
      filters.push({ createdAt: range });
    }

    const where: Prisma.AuditLogWhereInput = filters.length ? { AND: filters } : {};

    const [total, rows] = await prisma.$transaction([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);

    const appliedKeys = Object.entries({
      action: q.action,
      entityType: q.entityType,
      entityId: q.entityId,
      since: q.since,
      until: q.until,
    })
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k);

    await writeAudit({
      actorUserId: user.id,
      entityType: 'User',
      entityId: user.id,
      action: 'audit.queried',
      meta: {
        filterKeys: appliedKeys,
        scope: user.role === 'ADMIN' ? 'all' : 'self',
        count: rows.length,
        page: q.page,
        pageSize: q.pageSize,
      },
    });

    const events: AuditSummary[] = rows.map((r) => ({
      id: r.id,
      actorUserId: r.actorUserId,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      meta: r.meta,
      createdAt: r.createdAt.toISOString(),
    }));

    return NextResponse.json({
      events,
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
