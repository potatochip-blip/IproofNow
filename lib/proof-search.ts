import type { Prisma } from '@prisma/client';

/**
 * Vault / proof-search filter parameters. Kept as a plain DTO (no zod here)
 * so route handlers own their own validation and this module stays a
 * pure filter-composition utility.
 *
 * Phase 4 case search is expected to reuse the same `q` fuzzy-match shape
 * against a different entity — keep the `q` splitting logic here rather
 * than inlining it in the route.
 */
export type ProofSearchParams = {
  q?: string | null;
  proofType?: string | null;
  category?: string | null;
  status?: 'DRAFT' | 'SEALED' | null;
  visibility?: 'PRIVATE' | 'PUBLIC' | 'ORG' | null;
};

/**
 * Build the search/filter portion of a Prisma where — NOT the ownership or
 * hidden-vault scoping. Route handlers compose this with their own scope so
 * this module stays route-agnostic.
 *
 * `q` matches:
 *   - title ILIKE %q%
 *   - description ILIKE %q%
 *   - peopleInvolved contains the exact string q
 *
 * Phase 3 uses ILIKE; Phase 5+ will swap to a Postgres tsvector column.
 * Array-element substring match is not native to Prisma, so peopleInvolved
 * matches the full tag — documented limitation.
 */
export function buildProofSearchFilters(
  params: ProofSearchParams
): Prisma.ProofWhereInput[] {
  const filters: Prisma.ProofWhereInput[] = [];

  const q = params.q?.trim();
  if (q) {
    filters.push({
      OR: [
        { title: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
        { peopleInvolved: { has: q } },
      ],
    });
  }

  if (params.proofType) filters.push({ proofType: params.proofType });
  if (params.category) filters.push({ categoryKey: params.category });
  if (params.status) filters.push({ status: params.status });
  if (params.visibility) filters.push({ visibility: params.visibility });

  return filters;
}

export type ProofSortBy = 'createdAt' | 'sealedAt' | 'title';
export type ProofSortDir = 'asc' | 'desc';

export function buildProofOrderBy(
  sortBy: ProofSortBy,
  sortDir: ProofSortDir
): Prisma.ProofOrderByWithRelationInput {
  return { [sortBy]: sortDir } as Prisma.ProofOrderByWithRelationInput;
}
