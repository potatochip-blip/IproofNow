import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/guards';
import { serializeUser } from '@/lib/serializers';
import { errorResponse } from '@/lib/errors';

/**
 * GET /api/auth/session — frontend-compatibility alias for /api/auth/me.
 * Frontend lib/store/auth-store.ts:73 calls this path on app boot.
 *
 * Returns ONLY { user } (the shape that auth-store.mapApiUser reads). The
 * canonical /me route additionally returns `role` for convenience.
 */
export async function GET() {
  try {
    const { user } = await requireSession();
    return NextResponse.json({ user: serializeUser(user) });
  } catch (err) {
    return errorResponse(err);
  }
}
