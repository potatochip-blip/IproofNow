import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/guards';
import { errorResponse } from '@/lib/errors';
import { writeAudit } from '@/lib/audit';
import { loadProofForRead } from '@/lib/proof-guards';
import { serializeProof } from '@/lib/proof-serializers';

type RouteCtx = { params: { proofId: string } };

/**
 * GET /api/proofs/:proofId/export — single-document export.
 *
 * Same access ladder as loadProofForRead (owner / same-org-non-PRIVATE /
 * PUBLIC; hidden-vault → 404 to non-owners). Returns the full serialized
 * proof plus the anchor row (if any). The frontend uses this for "download
 * proof as JSON" — a self-contained snapshot the user can keep, hash, and
 * compare to the on-record proof later.
 *
 * Audit: `proof.exported` — sensitive read. meta.fileCount /
 * meta.hasAttestation / meta.anchored give the audit reviewer enough to
 * understand what left the system without dumping the payload itself.
 */
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    const { user } = await requireSession();
    const proof = await loadProofForRead(ctx.params.proofId, user);

    const anchor = await prisma.proofAnchor.findUnique({
      where: { proofId: proof.id },
    });

    const serialized = await serializeProof(proof);

    await writeAudit({
      actorUserId: user.id,
      entityType: 'Proof',
      entityId: proof.id,
      action: 'proof.exported',
      meta: {
        fileCount: proof.files.length,
        hasAttestation: proof.attestation !== null,
        anchored: anchor !== null,
      },
    });

    return NextResponse.json({
      proof: serialized,
      anchor: anchor
        ? {
            status: anchor.status,
            anchoredAt: anchor.anchoredAt.toISOString(),
            confirmedAt: anchor.confirmedAt?.toISOString() ?? null,
            // contentHash is the digest we submitted to OpenTimestamps —
            // recompute lib/ots/proof-digest to detect tampering.
            contentHash: anchor.contentHash
              ? Buffer.from(anchor.contentHash).toString('hex')
              : null,
            // The OTS receipt: PENDING → partial proof; CONFIRMED → full
            // receipt independently verifiable with the `ots` CLI.
            otsProof: Buffer.from(anchor.otsProof).toString('base64'),
            bitcoinBlockHeight: anchor.bitcoinBlockHeight,
            bitcoinBlockHash: anchor.bitcoinBlockHash,
            // Re-check the anchor against the calendars / block explorer
            // without trusting this payload.
            verifyUrl: `/api/proofs/${proof.id}/anchor/verify`,
          }
        : null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
