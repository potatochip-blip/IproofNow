import type { Case, CaseProof, EvidencePackage } from '@prisma/client';
import { prisma } from './db';
import { ForbiddenError, NotFoundError } from './errors';
import type { Actor } from './proof-guards';

export type CaseWithRelations = Case & {
  proofLinks: CaseProof[];
  evidencePackages: EvidencePackage[];
};

function isOwner(c: Pick<Case, 'ownerUserId'>, actor: Actor): boolean {
  return c.ownerUserId === actor.id;
}

function isSameOrg(c: Pick<Case, 'orgId'>, actor: Actor): boolean {
  return !!c.orgId && !!actor.orgId && c.orgId === actor.orgId;
}

export function caseIsSameOrg(
  c: Pick<Case, 'orgId'>,
  actor: Actor
): boolean {
  return isSameOrg(c, actor);
}

export function caseIsOwner(
  c: Pick<Case, 'ownerUserId'>,
  actor: Actor
): boolean {
  return isOwner(c, actor);
}

/**
 * Load a case for read. Access:
 *   - owner OR same-org → allow
 *   - otherwise         → 404 (don't leak existence)
 *
 * Cases have no hidden-vault concept (only proofs do), so the read rule is
 * symmetric with proofs minus the visibility ladder.
 */
export async function loadCaseForRead(
  caseId: string,
  actor: Actor
): Promise<CaseWithRelations> {
  const c = await prisma.case.findUnique({
    where: { id: caseId },
    include: { proofLinks: true, evidencePackages: true },
  });
  if (!c) throw new NotFoundError('Case not found');
  if (isOwner(c, actor) || isSameOrg(c, actor)) return c;
  throw new NotFoundError('Case not found');
}

/**
 * Load a case the actor intends to mutate. Owner-only.
 *   - missing  → 404
 *   - !owner   → 403 (leak is acceptable — case IDs aren't sensitive in the
 *                way hidden-vault proofs are)
 */
export async function loadCaseForWrite(
  caseId: string,
  actor: Actor
): Promise<CaseWithRelations> {
  const c = await prisma.case.findUnique({
    where: { id: caseId },
    include: { proofLinks: true, evidencePackages: true },
  });
  if (!c) throw new NotFoundError('Case not found');
  if (!isOwner(c, actor)) throw new ForbiddenError('You do not own this case');
  return c;
}
