import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/guards';
import { errorResponse, ForbiddenError, NotFoundError } from '@/lib/errors';

type RouteCtx = { params: { notificationId: string } };

const PatchBody = z.object({ read: z.boolean() }).strict();

/**
 * PATCH /api/notifications/:notificationId — toggle readAt.
 *
 * 403/404 split (different from proof endpoints): notifications aren't
 * sensitive content, so we don't mask foreign-notification existence as
 * 404. Missing → 404, not-own → 403.
 */
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  try {
    const { user } = await requireSession();
    const json = await req.json().catch(() => ({}));
    const { read } = PatchBody.parse(json);

    const row = await prisma.notification.findUnique({
      where: { id: ctx.params.notificationId },
    });
    if (!row) throw new NotFoundError('Notification not found');
    if (row.userId !== user.id) throw new ForbiddenError('Not your notification');

    const updated = await prisma.notification.update({
      where: { id: row.id },
      data: { readAt: read ? new Date() : null },
    });

    return NextResponse.json({
      id: updated.id,
      readAt: updated.readAt?.toISOString() ?? null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
