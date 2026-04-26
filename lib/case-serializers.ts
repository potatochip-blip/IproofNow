import type { Case, EvidencePackage, PackageStatus } from '@prisma/client';

// ─── Frontend string unions ──────────────────────────────────────────────

export type FrontendPackageStatus = 'pending' | 'ready' | 'failed';

const PACKAGE_STATUS_TO_FRONTEND: Record<PackageStatus, FrontendPackageStatus> = {
  PENDING: 'pending',
  READY: 'ready',
  FAILED: 'failed',
};

export function packageStatusToFrontend(s: PackageStatus): FrontendPackageStatus {
  // Records keyed on a closed enum are exhaustive; non-null is the standard
  // workaround for `noUncheckedIndexedAccess`.
  return PACKAGE_STATUS_TO_FRONTEND[s]!;
}

// ─── Serialized shapes ────────────────────────────────────────────────────

export type SerializedCaseSummary = {
  id: string;
  title: string;
  description: string;
  status: string;
  organizationId: string | null;
  ownerUserId: string;
  createdAt: string;
  updatedAt: string;
  linkedProofCount: number;
  packageCount: number;
};

export type SerializedPackageSummary = {
  id: string;
  caseId: string | null;
  proofId: string | null;
  status: FrontendPackageStatus;
  packageType: string;
  createdByUserId: string;
  createdAt: string;
};

// ─── Serializers ──────────────────────────────────────────────────────────

/**
 * Optional `proofLinks` / `evidencePackages` carry counts only — the list
 * endpoint and detail endpoint both call this and just project a length.
 */
export function serializeCaseSummary(
  c: Case & {
    proofLinks?: { id: string }[];
    evidencePackages?: { id: string }[];
  }
): SerializedCaseSummary {
  return {
    id: c.id,
    title: c.title,
    description: c.description,
    status: c.status,
    organizationId: c.orgId,
    ownerUserId: c.ownerUserId,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    linkedProofCount: c.proofLinks?.length ?? 0,
    packageCount: c.evidencePackages?.length ?? 0,
  };
}

export function serializePackageSummary(p: EvidencePackage): SerializedPackageSummary {
  return {
    id: p.id,
    caseId: p.caseId,
    proofId: p.proofId,
    status: packageStatusToFrontend(p.status),
    packageType: p.packageType,
    createdByUserId: p.createdByUserId,
    createdAt: p.createdAt.toISOString(),
  };
}
