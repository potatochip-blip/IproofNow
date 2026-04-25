-- CreateEnum
CREATE TYPE "Role" AS ENUM ('INDIVIDUAL', 'COMPANY', 'LAWYER', 'LAW_ENFORCEMENT', 'GOVERNMENT', 'ADMIN');

-- CreateEnum
CREATE TYPE "ProofStatus" AS ENUM ('DRAFT', 'SEALED');

-- CreateEnum
CREATE TYPE "Visibility" AS ENUM ('PRIVATE', 'PUBLIC', 'ORG');

-- CreateEnum
CREATE TYPE "PackageStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "SubscriptionTier" AS ENUM ('FREE', 'PRO', 'BUSINESS', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "HashStatus" AS ENUM ('PENDING', 'COMPLETE', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "orgId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "subscriptionTier" "SubscriptionTier" NOT NULL DEFAULT 'FREE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Proof" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "orgId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "categoryKey" TEXT NOT NULL,
    "proofType" TEXT NOT NULL,
    "status" "ProofStatus" NOT NULL DEFAULT 'DRAFT',
    "visibility" "Visibility" NOT NULL DEFAULT 'PRIVATE',
    "eventDate" TIMESTAMP(3),
    "peopleInvolved" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "locationMode" TEXT,
    "manualLocation" TEXT,
    "roleContext" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sealedAt" TIMESTAMP(3),

    CONSTRAINT "Proof_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProofFile" (
    "id" TEXT NOT NULL,
    "proofId" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "storagePath" TEXT NOT NULL,
    "fileHash" TEXT,
    "hashStatus" "HashStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProofFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProofAttestation" (
    "id" TEXT NOT NULL,
    "proofId" TEXT NOT NULL,
    "attestationName" TEXT NOT NULL,
    "attestationLocation" TEXT NOT NULL,
    "attestationText" TEXT NOT NULL,
    "attestationFileId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProofAttestation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationRecord" (
    "id" TEXT NOT NULL,
    "proofId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "requesterContext" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "href" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Case" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "orgId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Case_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseProof" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "proofId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseProof_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidencePackage" (
    "id" TEXT NOT NULL,
    "caseId" TEXT,
    "proofId" TEXT,
    "status" "PackageStatus" NOT NULL DEFAULT 'PENDING',
    "packageType" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "storagePath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidencePackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PreservationConfig" (
    "id" TEXT NOT NULL,
    "proofId" TEXT NOT NULL,
    "preservationMode" BOOLEAN NOT NULL DEFAULT false,
    "hiddenVaultMode" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PreservationConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE INDEX "User_orgId_idx" ON "User"("orgId");

-- CreateIndex
CREATE INDEX "Organization_ownerUserId_idx" ON "Organization"("ownerUserId");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "Proof_ownerUserId_idx" ON "Proof"("ownerUserId");

-- CreateIndex
CREATE INDEX "Proof_orgId_idx" ON "Proof"("orgId");

-- CreateIndex
CREATE INDEX "Proof_status_idx" ON "Proof"("status");

-- CreateIndex
CREATE INDEX "Proof_createdAt_idx" ON "Proof"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "Proof_ownerUserId_status_idx" ON "Proof"("ownerUserId", "status");

-- CreateIndex
CREATE INDEX "Proof_orgId_status_idx" ON "Proof"("orgId", "status");

-- CreateIndex
CREATE INDEX "ProofFile_proofId_idx" ON "ProofFile"("proofId");

-- CreateIndex
CREATE UNIQUE INDEX "ProofAttestation_proofId_key" ON "ProofAttestation"("proofId");

-- CreateIndex
CREATE INDEX "VerificationRecord_proofId_idx" ON "VerificationRecord"("proofId");

-- CreateIndex
CREATE INDEX "VerificationRecord_createdAt_idx" ON "VerificationRecord"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Case_ownerUserId_idx" ON "Case"("ownerUserId");

-- CreateIndex
CREATE INDEX "Case_orgId_idx" ON "Case"("orgId");

-- CreateIndex
CREATE INDEX "Case_status_idx" ON "Case"("status");

-- CreateIndex
CREATE INDEX "CaseProof_caseId_idx" ON "CaseProof"("caseId");

-- CreateIndex
CREATE INDEX "CaseProof_proofId_idx" ON "CaseProof"("proofId");

-- CreateIndex
CREATE UNIQUE INDEX "CaseProof_caseId_proofId_key" ON "CaseProof"("caseId", "proofId");

-- CreateIndex
CREATE INDEX "EvidencePackage_caseId_idx" ON "EvidencePackage"("caseId");

-- CreateIndex
CREATE INDEX "EvidencePackage_proofId_idx" ON "EvidencePackage"("proofId");

-- CreateIndex
CREATE INDEX "EvidencePackage_createdByUserId_idx" ON "EvidencePackage"("createdByUserId");

-- CreateIndex
CREATE INDEX "EvidencePackage_status_idx" ON "EvidencePackage"("status");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_createdAt_idx" ON "AuditLog"("entityType", "entityId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_actorUserId_createdAt_idx" ON "AuditLog"("actorUserId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "PreservationConfig_proofId_key" ON "PreservationConfig"("proofId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proof" ADD CONSTRAINT "Proof_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proof" ADD CONSTRAINT "Proof_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProofFile" ADD CONSTRAINT "ProofFile_proofId_fkey" FOREIGN KEY ("proofId") REFERENCES "Proof"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProofAttestation" ADD CONSTRAINT "ProofAttestation_proofId_fkey" FOREIGN KEY ("proofId") REFERENCES "Proof"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationRecord" ADD CONSTRAINT "VerificationRecord_proofId_fkey" FOREIGN KEY ("proofId") REFERENCES "Proof"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseProof" ADD CONSTRAINT "CaseProof_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseProof" ADD CONSTRAINT "CaseProof_proofId_fkey" FOREIGN KEY ("proofId") REFERENCES "Proof"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidencePackage" ADD CONSTRAINT "EvidencePackage_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidencePackage" ADD CONSTRAINT "EvidencePackage_proofId_fkey" FOREIGN KEY ("proofId") REFERENCES "Proof"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidencePackage" ADD CONSTRAINT "EvidencePackage_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PreservationConfig" ADD CONSTRAINT "PreservationConfig_proofId_fkey" FOREIGN KEY ("proofId") REFERENCES "Proof"("id") ON DELETE CASCADE ON UPDATE CASCADE;
