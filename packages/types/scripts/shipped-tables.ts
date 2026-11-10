/** A file's `tables` are judged by `judge_tables` in `marfa-rules`, so they are set aside before this package's validator reads the rest. */
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
