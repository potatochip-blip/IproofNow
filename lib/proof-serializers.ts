import type {
  Proof,
  ProofFile,
  ProofAttestation,
  ProofStatus,
  Visibility,
  HashStatus,
  PreservationConfig,
} from '@prisma/client';
import { getPresignedGetUrl } from './storage';

// ─── Frontend string unions (lowercase at the boundary) ──────────────────

export type FrontendProofStatus = 'draft' | 'sealed';
export type FrontendVisibility = 'private' | 'public' | 'org';
export type FrontendHashStatus = 'pending' | 'complete' | 'failed';

const STATUS_TO_FRONTEND: Record<ProofStatus, FrontendProofStatus> = {
  DRAFT: 'draft',
  SEALED: 'sealed',
};

const VISIBILITY_TO_FRONTEND: Record<Visibility, FrontendVisibility> = {
  PRIVATE: 'private',
  PUBLIC: 'public',
  ORG: 'org',
};

const HASH_STATUS_TO_FRONTEND: Record<HashStatus, FrontendHashStatus> = {
  PENDING: 'pending',
  COMPLETE: 'complete',
  FAILED: 'failed',
};

export function proofStatusToFrontend(s: ProofStatus): FrontendProofStatus {
  // Records keyed on a closed enum are exhaustive; non-null is the standard
  // workaround for `noUncheckedIndexedAccess`.
  return STATUS_TO_FRONTEND[s]!;
}

export function visibilityToFrontend(v: Visibility): FrontendVisibility {
  return VISIBILITY_TO_FRONTEND[v]!;
}

export function hashStatusToFrontend(h: HashStatus): FrontendHashStatus {
  return HASH_STATUS_TO_FRONTEND[h]!;
}

// ─── Serialized shapes ────────────────────────────────────────────────────

export type SerializedPreservation = {
  preservationMode: boolean;
  hiddenVaultMode: boolean;
};

export type SerializedProofFile = {
  id: string;
  proofId: string;
  originalName: string;
  mimeType: string;
  size: number;
  fileHash: string | null;
  hashStatus: FrontendHashStatus;
  createdAt: string;
  downloadUrl: string;
};

export type SerializedAttestation = {
  id: string;
  proofId: string;
  attestationName: string;
  attestationLocation: string;
  attestationText: string;
  attestationFileId: string | null;
  createdAt: string;
};

export type SerializedProofSummary = {
  id: string;
  title: string;
  status: FrontendProofStatus;
  category: string;
  proofType: string;
  visibility: FrontendVisibility;
  createdAt: string;
  sealedAt: string | null;
};

export type SerializedProof = SerializedProofSummary & {
  description: string;
  ownerUserId: string;
  organizationId: string | null;
  eventDate: string | null;
  peopleInvolved: string[];
  notes: string | null;
  locationMode: string | null;
  manualLocation: string | null;
  roleContext: string | null;
  updatedAt: string;
  preservation: SerializedPreservation;
  files: SerializedProofFile[];
  attestation: SerializedAttestation | null;
};

// ─── Serializers ──────────────────────────────────────────────────────────

export function serializeProofSummary(p: Proof): SerializedProofSummary {
  return {
    id: p.id,
    title: p.title,
    status: proofStatusToFrontend(p.status),
    category: p.categoryKey,
    proofType: p.proofType,
    visibility: visibilityToFrontend(p.visibility),
    createdAt: p.createdAt.toISOString(),
    sealedAt: p.sealedAt?.toISOString() ?? null,
  };
}

export function serializeAttestation(a: ProofAttestation): SerializedAttestation {
  return {
    id: a.id,
    proofId: a.proofId,
    attestationName: a.attestationName,
    attestationLocation: a.attestationLocation,
    attestationText: a.attestationText,
    attestationFileId: a.attestationFileId,
    createdAt: a.createdAt.toISOString(),
  };
}

export function serializePreservation(
  cfg: PreservationConfig | null | undefined
): SerializedPreservation {
  return {
    preservationMode: cfg?.preservationMode ?? false,
    hiddenVaultMode: cfg?.hiddenVaultMode ?? false,
  };
}

/**
 * File serializer is async because it signs a download URL. Field is
 * `downloadUrl` — when thumbnails / transcoded variants arrive later, those
 * get their own namespaced fields (`thumbnailUrl`, `previewUrl`) and this
 * one keeps its meaning.
 */
export async function serializeFile(f: ProofFile): Promise<SerializedProofFile> {
  const downloadUrl = await getPresignedGetUrl(f.storagePath);
  return {
    id: f.id,
    proofId: f.proofId,
    originalName: f.originalName,
    mimeType: f.mimeType,
    size: f.size,
    fileHash: f.fileHash,
    hashStatus: hashStatusToFrontend(f.hashStatus),
    createdAt: f.createdAt.toISOString(),
    downloadUrl,
  };
}

export type ProofWithRelations = Proof & {
  files: ProofFile[];
  attestation: ProofAttestation | null;
  preservation: PreservationConfig | null;
};

export async function serializeProof(p: ProofWithRelations): Promise<SerializedProof> {
  const summary = serializeProofSummary(p);
  const files = await Promise.all(p.files.map(serializeFile));
  return {
    ...summary,
    description: p.description,
    ownerUserId: p.ownerUserId,
    organizationId: p.orgId,
    eventDate: p.eventDate?.toISOString() ?? null,
    peopleInvolved: p.peopleInvolved,
    notes: p.notes,
    locationMode: p.locationMode,
    manualLocation: p.manualLocation,
    roleContext: p.roleContext,
    updatedAt: p.updatedAt.toISOString(),
    preservation: serializePreservation(p.preservation),
    files,
    attestation: p.attestation ? serializeAttestation(p.attestation) : null,
  };
}
