import { NextResponse } from 'next/server';
import type { Role, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/guards';
import { errorResponse } from '@/lib/errors';
import { roleToFrontend } from '@/lib/serializers';

/**
 * GET /api/dashboard — role-aware summary payload.
 *
 * Shape (provisional — see CLAUDE.md → "Dashboard contract"):
 *   {
 *     stats: { totalProofs, sealedProofs, recentVerifications },
 *     recentProofs: SerializedProofSummary[],
 *     recentActivity: SerializedAuditSummary[],
 *     notificationsSummary: { unread, total },
 *     roleWidgets: { ... role-specific }
 *   }
 *
 * All-zero on an empty DB is the correct Phase-1 behavior.
 */

type ProofSummary = {
  id: string;
  title: string;
  status: 'draft' | 'sealed';
  category: string;
  createdAt: string;
  sealedAt: string | null;
};

type AuditSummary = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  createdAt: string;
};

const RECENT_WINDOW_DAYS = 30;

export async function GET() {
  try {
    const { user } = await requireSession();

    // Scope: own proofs + (when org-bound) the user's org's proofs.
    const proofWhere: Prisma.ProofWhereInput = user.orgId
      ? { OR: [{ ownerUserId: user.id }, { orgId: user.orgId }] }
      : { ownerUserId: user.id };

    const sinceRecent = new Date(Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const [
      totalProofs,
      sealedProofs,
      recentVerifications,
      recentProofRows,
      recentActivityRows,
      notificationsTotal,
      notificationsUnread,
      roleWidgets,
    ] = await Promise.all([
      prisma.proof.count({ where: proofWhere }),
      prisma.proof.count({ where: { ...proofWhere, status: 'SEALED' } }),
      prisma.verificationRecord.count({
        where: { proof: proofWhere, createdAt: { gte: sinceRecent } },
      }),
      prisma.proof.findMany({
        where: proofWhere,
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          title: true,
          status: true,
          categoryKey: true,
          createdAt: true,
          sealedAt: true,
        },
      }),
      prisma.auditLog.findMany({
        where: { actorUserId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          action: true,
          entityType: true,
          entityId: true,
          createdAt: true,
        },
      }),
      prisma.notification.count({ where: { userId: user.id } }),
      prisma.notification.count({ where: { userId: user.id, readAt: null } }),
      computeRoleWidgets(user.role, user.id, user.orgId),
    ]);

    const recentProofs: ProofSummary[] = recentProofRows.map((p) => ({
      id: p.id,
      title: p.title,
      status: p.status === 'SEALED' ? 'sealed' : 'draft',
      category: p.categoryKey,
      createdAt: p.createdAt.toISOString(),
      sealedAt: p.sealedAt?.toISOString() ?? null,
    }));

    const recentActivity: AuditSummary[] = recentActivityRows.map((a) => ({
      id: a.id,
      action: a.action,
      entityType: a.entityType,
      entityId: a.entityId,
      createdAt: a.createdAt.toISOString(),
    }));

    return NextResponse.json({
      role: roleToFrontend(user.role),
      stats: { totalProofs, sealedProofs, recentVerifications },
      recentProofs,
      recentActivity,
      notificationsSummary: { unread: notificationsUnread, total: notificationsTotal },
      roleWidgets,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

async function computeRoleWidgets(
  role: Role,
  userId: string,
  orgId: string | null
): Promise<Record<string, unknown>> {
  switch (role) {
    case 'INDIVIDUAL': {
      const personalProofs = await prisma.proof.count({ where: { ownerUserId: userId } });
      return { personalProofs };
    }
    case 'COMPANY': {
      const orgProofs = orgId ? await prisma.proof.count({ where: { orgId } }) : 0;
      const teamMembers = orgId ? await prisma.user.count({ where: { orgId } }) : 0;
      return { orgProofs, teamMembers };
    }
    case 'LAWYER': {
      const [activeCases, packagesReady] = await Promise.all([
        prisma.case.count({ where: { ownerUserId: userId, status: 'active' } }),
        prisma.evidencePackage.count({ where: { createdByUserId: userId, status: 'READY' } }),
      ]);
      return { activeCases, packagesReady };
    }
    case 'LAW_ENFORCEMENT': {
      const activeCases = await prisma.case.count({
        where: { ownerUserId: userId, status: 'active' },
      });
      return { activeCases };
    }
    case 'GOVERNMENT': {
      const complianceItems = await prisma.proof.count({
        where: orgId ? { orgId } : { ownerUserId: userId },
      });
      return { complianceItems };
    }
    case 'ADMIN': {
      const [totalUsers, totalOrgs] = await Promise.all([
        prisma.user.count(),
        prisma.organization.count(),
      ]);
      return { totalUsers, totalOrgs };
    }
  }
}
