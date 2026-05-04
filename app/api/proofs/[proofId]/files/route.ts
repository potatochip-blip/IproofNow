import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireSession } from '@/lib/guards';
import { errorResponse, ValidationError } from '@/lib/errors';
import { writeAudit } from '@/lib/audit';
import { enqueueJob } from '@/lib/jobs';
import { assertNotSealed, loadProofForRead, loadProofForWrite } from '@/lib/proof-guards';
import { serializeFile } from '@/lib/proof-serializers';
import { putObject } from '@/lib/storage';

type RouteCtx = { params: { proofId: string } };

const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB

const ALLOWED_MIME = new Set<string>([
  'application/pdf',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

function isAllowedMime(mime: string): boolean {
  if (ALLOWED_MIME.has(mime)) return true;
  return (
    mime.startsWith('image/') ||
    mime.startsWith('video/') ||
    mime.startsWith('audio/')
  );
}

/** POST /api/proofs/:proofId/files — multipart upload. Owner-only; 409 if sealed. */
export async function POST(req: NextRequest, ctx: RouteCtx) {
  try {
    const { user } = await requireSession();
    const proof = await loadProofForWrite(ctx.params.proofId, user);
    assertNotSealed(proof);

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw new ValidationError('Expected multipart/form-data body');
    }
    const raw = form.get('file');
    if (!(raw instanceof File)) {
      throw new ValidationError('Missing "file" form field');
    }

    if (raw.size > MAX_FILE_BYTES) {
      throw new ValidationError(`File exceeds ${MAX_FILE_BYTES} byte limit`);
    }
    if (raw.size === 0) {
      throw new ValidationError('Empty file');
    }
    const mimeType = raw.type || 'application/octet-stream';
    if (!isAllowedMime(mimeType)) {
      throw new ValidationError(`MIME type not allowed: ${mimeType}`);
    }

    // Create the row first so we can use its id in the storage key.
    const fileRow = await prisma.proofFile.create({
      data: {
        proofId: proof.id,
        originalName: raw.name || 'upload',
        mimeType,
        size: raw.size,
        storagePath: '__pending__',
      },
    });

    const storagePath = `proofs/${proof.id}/${fileRow.id}`;
    try {
      const bytes = Buffer.from(await raw.arrayBuffer());
      await putObject(storagePath, bytes, mimeType);
    } catch (err) {
      // Best-effort cleanup of the orphan row so the list endpoint doesn't
      // return a file that has no backing object.
      await prisma.proofFile.delete({ where: { id: fileRow.id } }).catch(() => {});
      throw err;
    }

    const finalRow = await prisma.proofFile.update({
      where: { id: fileRow.id },
      data: { storagePath },
    });

    // Schedule the hash worker. Best-effort: failure to enqueue must not
    // break the upload response. The worker itself flips hashStatus from
    // PENDING → COMPLETE/FAILED; if no job ran we just stay PENDING and
    // an ops sweep can re-enqueue.
    try {
      await enqueueJob('proof_file.hash', { fileId: finalRow.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Non-fatal — log via the audit as a sensitive op so it surfaces in
      // dashboards rather than disappearing into stderr only.
      await writeAudit({
        actorUserId: user.id,
        entityType: 'ProofFile',
        entityId: finalRow.id,
        action: 'job.failed',
        meta: { type: 'proof_file.hash', stage: 'enqueue', error: message.slice(0, 1024) },
      });
    }

    await writeAudit({
      actorUserId: user.id,
      entityType: 'Proof',
      entityId: proof.id,
      action: 'proof.file.uploaded',
      meta: {
        fileId: finalRow.id,
        mimeType,
        size: finalRow.size,
        originalName: finalRow.originalName,
      },
    });

    return NextResponse.json(
      { file: await serializeFile(finalRow) },
      { status: 201 }
    );
  } catch (err) {
    return errorResponse(err);
  }
}

/** GET /api/proofs/:proofId/files — list files + presigned download URLs. */
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    const { user } = await requireSession();
    const proof = await loadProofForRead(ctx.params.proofId, user);
    const files = await Promise.all(proof.files.map(serializeFile));
    return NextResponse.json({ files });
  } catch (err) {
    return errorResponse(err);
  }
}
