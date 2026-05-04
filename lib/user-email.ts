/**
 * Centralized email normalizer. Use everywhere a User row is created or
 * looked up by email so the table never grows mixed-case duplicates.
 *
 *   normalizeEmail('  Bob@Example.COM ') → 'bob@example.com'
 *
 * Rationale: even though `User.email` has a unique constraint, two writes
 * with different casing would each succeed unless the column is
 * citext-typed. We don't want to depend on Postgres-specific column types,
 * so we normalize at the application boundary.
 */
export function normalizeEmail(s: string): string {
  return s.trim().toLowerCase();
}
