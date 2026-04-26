import type { Prisma } from '@prisma/client';

/**
 * Case search/filter parameters. Mirrors `lib/proof-search.ts` in shape but
 * lives in its own file so each entity can evolve its own column set without
 * the other module's typing pulling it sideways. Phase 4 added the
 * per-entity split deliberately — see CLAUDE.md "Proof-search q semantics".
 */
export type CaseSearchParams = {
  q?: string | null;
  status?: string | null;
};

/**
 * Build the search/filter portion of a Prisma where — NOT the
 * ownership / org scoping. Route handlers compose this with their own
 * scope so this stays route-agnostic.
 *
 * `q` matches:
 *   - title       ILIKE %q%
 *   - description ILIKE %q%
 *
 * Phase 4 uses ILIKE; Phase 5+ may swap to a tsvector column.
 */
export function buildCaseSearchFilters(
  params: CaseSearchParams
): Prisma.CaseWhereInput[] {
  const filters: Prisma.CaseWhereInput[] = [];

  const q = params.q?.trim();
  if (q) {
    filters.push({
      OR: [
        { title: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
      ],
    });
  }

  if (params.status) filters.push({ status: params.status });

  return filters;
}
