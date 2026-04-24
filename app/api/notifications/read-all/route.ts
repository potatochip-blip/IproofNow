import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/guards';
import { errorResponse } from '@/lib/errors';

/** POST /api/notifications/read-all — mark all of the caller's notifications read. */
export async function POST() {
  try {
    const { user } = await requireSession();
    const now = new Date();
    const res = await prisma.notification.updateMany({
      where: { userId: user.id, readAt: null },
      data: { readAt: now },
    });
    return NextResponse.json({ ok: true, updated: res.count });
  } catch (err) {
    return errorResponse(err);
  }
}
