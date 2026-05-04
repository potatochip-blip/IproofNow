import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { verifyPassword } from '@/lib/password';
import { createSession, generateSessionToken } from '@/lib/session';
import { setSessionCookie } from '@/lib/cookies';
import { serializeUser } from '@/lib/serializers';
import { writeAudit } from '@/lib/audit';
import { errorResponse, TooManyRequestsError, UnauthorizedError } from '@/lib/errors';
import { consume, ipKey } from '@/lib/rate-limit';
import { normalizeEmail } from '@/lib/user-email';

const LoginBody = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(1024),
});

export async function POST(req: NextRequest) {
  try {
    // Rate limit BEFORE the password verify (argon2 is intentionally slow,
    // so unbounded attempts amplify the asymmetry against the server). 5
    // attempts / 15 min / IP is the OWASP login default.
    const key = ipKey(req);
    if (!consume(key)) {
      await writeAudit({
        actorUserId: null,
        entityType: 'User',
        entityId: 'unknown',
        action: 'auth.login.failure',
        meta: { reason: 'rate_limited', ipKey: key },
      });
      throw new TooManyRequestsError('Too many login attempts; try again later');
    }

    const json = await req.json().catch(() => ({}));
    const { email: rawEmail, password } = LoginBody.parse(json);
    const email = normalizeEmail(rawEmail);

    const user = await prisma.user.findUnique({
      where: { email },
      include: { org: { select: { id: true, name: true } } },
    });

    if (!user) {
      await writeAudit({
        actorUserId: null,
        entityType: 'User',
        entityId: 'unknown',
        action: 'auth.login.failure',
        meta: { email, reason: 'no_such_user' },
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
