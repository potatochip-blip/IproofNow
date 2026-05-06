import { NextResponse, type NextRequest } from 'next/server';
import { z, ZodError } from 'zod';
import { requireRole } from '@/lib/guards';
import { errorResponse, ValidationError } from '@/lib/errors';
import { writeAudit } from '@/lib/audit';
import { verifyAuditChain } from '@/lib/audit-chain';

const Query = z.object({
  since: z.string().datetime().optional(),
});

/**
 * GET /api/audit/verify — ADMIN-only.
 *
 * Walks the AuditLog hash chain (optionally bounded by ?since=ISO8601),
 * recomputes each entryHash, and verifies HMAC signatures where present.
 * Returns either { ok: true, count } or { ok: false, brokenAt, reason,
 * expected, actual }.
 *
 * Self-emits `audit.chain.verified` so a reviewer can later prove that the
 * chain was checked at a given moment AND that the check itself extends
 * the chain (a valid append after the verify confirms the chain head was
 * still consistent at that point).
 */
export async function GET(req: NextRequest) {
  try {
    const { user } = await requireRole('ADMIN');
    const url = new URL(req.url);
    const q = Query.parse(Object.fromEntries(url.searchParams.entries()));

    const since = q.since ? new Date(q.since) : undefined;
    const result = await verifyAuditChain({ since });

    await writeAudit({
      actorUserId: user.id,
      entityType: 'AuditLog',
      entityId: 'chain',
      action: 'audit.chain.verified',
      meta: {
        ok: result.ok,
        count: result.ok ? result.count : 0,
        ...(since ? { since: since.toISOString() } : {}),
        ...(result.ok ? {} : { brokenAt: result.brokenAt, reason: result.reason }),
      },
    });

    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ZodError) {
      return errorResponse(new ValidationError('Invalid query parameters', err.flatten()));
    }
    return errorResponse(err);
  }
}
