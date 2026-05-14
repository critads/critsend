/**
 * Convert a JS string[] into a PostgreSQL array literal so it can be safely
 * bound as a SINGLE parameter in a Drizzle `sql` template.
 *
 * Why this exists:
 *   `sql\`...ANY(${jsArray}::text[])\`` is compiled by drizzle-orm as
 *   `ANY(($1, $2, ...)::text[])` — a row constructor (record), NOT an array.
 *   PostgreSQL then errors with code 42846: "cannot cast type record to text[]".
 *
 *   Pass the result of this helper instead:
 *     sql`...ANY(${toPgTextArray(ids)}::text[])`
 *   which becomes `ANY($1::text[])` with `$1 = '{"id1","id2",...}'` —
 *   a single text param that PG parses as a real text[].
 */
export function toPgTextArray(values: readonly string[]): string {
  // Quote each value and escape embedded backslashes/double-quotes per
  // PG array literal rules. UUIDs/IDs don't need this in practice but
  // doing it correctly keeps the helper safe for arbitrary text.
  return `{${values.map(v => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(",")}}`;
}
