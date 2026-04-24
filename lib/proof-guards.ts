import type { User, Proof, ProofFile, ProofAttestation, PreservationConfig } from '@prisma/client';
import { prisma } from './db';
import { ConflictError, ForbiddenError, NotFoundError } from './errors';

export type ProofWithRelations = Proof & {
  files: ProofFile[];
  attestation: ProofAttestation | null;
  preservation: PreservationConfig | null;
};

type Actor = Pick<User, 'id' | 'orgId'>;

function isOwner(proof: Pick<Proof, 'ownerUserId'>, actor: Actor): boolean {
  return proof.ownerUserId === actor.id;
}

function isSameOrg(proof: Pick<Proof, 'orgId'>, actor: Actor): boolean {
  return !!proof.orgId && !!actor.orgId && proof.orgId === actor.orgId;
}

/**
 * Load a proof for read. Enforces:
 *  - owner OR (same org AND visibility !== PRIVATE)
 *  - hidden vault: if hiddenVaultMode && !owner, 404 (no existence leak)
 */
export async function loadProofForRead(
  proofId: string,
  actor: Actor
): Promise<ProofWithRelations> {
  const proof = await prisma.proof.findUnique({
    where: { id: proofId },
    include: { files: true, attestation: true, preservation: true },
  });
  if (!proof) throw new NotFoundError('Proof not found');

  const owner = isOwner(proof, actor);
  const hidden = proof.preservation?.hiddenVaultMode ?? false;

  if (hidden && !owner) {
    // Deliberate 404 — do not leak that the proof exists.
    throw new NotFoundError('Proof not found');
  }

  if (owner) return proof;

  const orgReadable =
    isSameOrg(proof, actor) && proof.visibility !== 'PRIVATE';
  const publicReadable = proof.visibility === 'PUBLIC';

  if (!orgReadable && !publicReadable) {
    throw new NotFoundError('Proof not found');
  }

  return proof;
}

/**
 * Load a proof the actor intends to mutate. Requires ownership; 403 otherwise.
 * Does NOT 404-mask hidden-vault since a non-owner never gets here under
 * normal flow (PATCH / file POST / seal all require ownership). But keep the
 * same 404 semantics for hidden-vault to avoid existence leaks via error
 * shape.
 */
export async function loadProofForWrite(
  proofId: string,
  actor: Actor
): Promise<ProofWithRelations> {
  const proof = await prisma.proof.findUnique({
    where: { id: proofId },
    include: { files: true, attestation: true, preservation: true },
  });
  if (!proof) throw new NotFoundError('Proof not found');

  const owner = isOwner(proof, actor);
  const hidden = proof.preservation?.hiddenVaultMode ?? false;

  if (!owner) {
    if (hidden) throw new NotFoundError('Proof not found');
    throw new ForbiddenError('You do not own this proof');
  }

  return proof;
}

export function assertNotSealed(proof: Pick<Proof, 'status'>): void {
  if (proof.status === 'SEALED') {
    throw new ConflictError('Proof is sealed and cannot be modified');
  }
}
