import { NextResponse } from 'next/server';
import { clearSessionCookie, readSessionToken } from '@/lib/cookies';
import { invalidateSession, sessionIdFromToken } from '@/lib/session';
import { writeAudit } from '@/lib/audit';
import { getCurrentSession } from '@/lib/guards';
import { errorResponse } from '@/lib/errors';

export async function POST() {
  try {
    const ctx = await getCurrentSession();
    const token = readSessionToken();

    if (token) {
      await invalidateSession(sessionIdFromToken(token));
    }
    clearSessionCookie();

    if (ctx) {
      await writeAudit({
        actorUserId: ctx.user.id,
        entityType: 'User',
        entityId: ctx.user.id,
        action: 'auth.logout',
        meta: { sessionId: ctx.session.id },
      });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
