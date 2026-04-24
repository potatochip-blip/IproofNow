import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/guards';
import { serializeUser, roleToFrontend } from '@/lib/serializers';
import { errorResponse } from '@/lib/errors';

/**
 * GET /api/auth/me — canonical session-restore endpoint.
 *
 * NOTE: /api/auth/session is a thin alias of this route. The frontend zip
 * shipped calling /api/auth/session; we serve both rather than churn the
 * frontend during backend bring-up.
 */
export async function GET() {
  try {
    const { user } = await requireSession();
    return NextResponse.json({
      user: serializeUser(user),
      role: roleToFrontend(user.role),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
