import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { verifyPassword } from '@/lib/password';
import { createSession, generateSessionToken } from '@/lib/session';
import { setSessionCookie } from '@/lib/cookies';
import { serializeUser } from '@/lib/serializers';
import { writeAudit } from '@/lib/audit';
import { errorResponse, UnauthorizedError } from '@/lib/errors';

const LoginBody = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(1024),
});

export async function POST(req: NextRequest) {
  try {
    const json = await req.json().catch(() => ({}));
    const { email, password } = LoginBody.parse(json);

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      include: { org: { select: { id: true, name: true } } },
    });

    if (!user) {
      await writeAudit({
        actorUserId: null,
        entityType: 'User',
        entityId: 'unknown',
        action: 'auth.login.failure',
        meta: { email: email.toLowerCase(), reason: 'no_such_user' },
      });
      throw new UnauthorizedError('Invalid email or password');
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      await writeAudit({
        actorUserId: user.id,
        entityType: 'User',
        entityId: user.id,
        action: 'auth.login.failure',
        meta: { email: user.email, reason: 'bad_password' },
      });
      throw new UnauthorizedError('Invalid email or password');
    }

    const token = generateSessionToken();
    const session = await createSession(token, user.id);
    setSessionCookie(token, session.expiresAt);

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    await writeAudit({
      actorUserId: user.id,
      entityType: 'User',
      entityId: user.id,
      action: 'auth.login.success',
      meta: { sessionId: session.id },
    });

    // Refresh lastLogin in the response payload.
    const refreshed = { ...user, lastLoginAt: new Date() };

    return NextResponse.json({ user: serializeUser(refreshed) });
  } catch (err) {
    return errorResponse(err);
  }
}
