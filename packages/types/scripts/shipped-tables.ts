/**
 * A shipped type's `tables` are judged by the Rust validator (`judge_tables` in
 * `marfa-rules`), which a test runs over the generated catalog. This validator
 * does not read them, so a file's `tables` is set aside before it reads the
 * rest and put back on the built schema.
 */
export function setAsideTables(data: Record<string, unknown>): {
  rest: Record<string, unknown>;
  tables: Record<string, unknown> | undefined;
} {
  const { tables, ...rest } = data;
  if (tables === undefined) return { rest, tables: undefined };
  if (tables === null || typeof tables !== "object" || Array.isArray(tables)) {
    throw new Error(`"tables" must be an object, as in ${String(data.id)}`);
  }
  return { rest, tables: tables as Record<string, unknown> };
}
