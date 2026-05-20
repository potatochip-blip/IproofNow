import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/guards';
import { errorResponse } from '@/lib/errors';
import { writeAudit } from '@/lib/audit';
import { loadProofForRead } from '@/lib/proof-guards';
import { parseOtsProof, upgradeOts } from '@/lib/ots/client';
import { getBlockByHeight } from '@/lib/ots/bitcoin-explorer';

type RouteCtx = { params: { proofId: string } };

/**
 * GET /api/proofs/:proofId/anchor/verify — independently re-check a proof's
 * OpenTimestamps anchor.
 *
 * Same access ladder as loadProofForRead (owner / same-org-non-PRIVATE /
 * PUBLIC; hidden-vault → 404 to non-owners).
 *
 * "Without trusting our database": rather than echoing ProofAnchor.status,
 * this parses the stored OTS receipt and re-checks it externally —
 *   - CONFIRMED: reads the Bitcoin attestation height out of the receipt
 *     and confirms a block exists at that height via the block explorer.
 *   - PENDING:   re-queries the calendars (read-only — no DB write) to see
 *     whether the receipt is upgradeable now.
 * `contentHashMatches` cross-checks that the receipt commits to the digest
 * we recorded in ProofAnchor.contentHash.
 *
 * Audits `proof.anchor.verified` (sensitive read).
 */
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    const { user } = await requireSession();
    const proof = await loadProofForRead(ctx.params.proofId, user);

    const anchor = await prisma.proofAnchor.findUnique({
      where: { proofId: proof.id },
    });

    const checkedAt = new Date().toISOString();

    // No anchor, or a legacy Phase-5 STUB — nothing real to verify.
    if (!anchor || anchor.status === 'STUB') {
      await writeAudit({
        actorUserId: user.id,
        entityType: 'Proof',
        entityId: proof.id,
        action: 'proof.anchor.verified',
        meta: { status: anchor?.status ?? null, confirmed: false },
      });
      return NextResponse.json({
        anchored: false,
        status: anchor?.status ?? null,
        confirmed: false,
        checkedAt,
      });
    }

    const otsProof = Buffer.from(anchor.otsProof);
    const parsed = parseOtsProof(otsProof);
    const contentHashMatches =
      anchor.contentHash !== null &&
      parsed.fileDigest.equals(Buffer.from(anchor.contentHash));

    // Resolve the Bitcoin attestation. CONFIRMED receipts carry it
    // directly; PENDING receipts get a live calendar re-query.
    let bitcoinHeight: number | null = parsed.bitcoin?.height ?? null;
    let confirmed = bitcoinHeight !== null;

    if (!confirmed) {
      const live = await upgradeOts(otsProof);
      if (live.confirmed && live.bitcoin) {
        confirmed = true;
        bitcoinHeight = live.bitcoin.height;
      }
    }

    let bitcoin: { height: number; blockHash: string | null; time: number | null } | null =
      null;
    if (confirmed && bitcoinHeight !== null) {
      const block = await getBlockByHeight(bitcoinHeight);
      bitcoin = {
        height: bitcoinHeight,
        blockHash: block?.blockHash ?? anchor.bitcoinBlockHash ?? null,
        time: block?.time ?? null,
      };
    }

    await writeAudit({
      actorUserId: user.id,
      entityType: 'Proof',
      entityId: proof.id,
      action: 'proof.anchor.verified',
      meta: { status: anchor.status, confirmed },
    });

    return NextResponse.json({
      anchored: true,
      status: anchor.status,
      contentHashMatches,
      confirmed,
      bitcoin,
      checkedAt,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
