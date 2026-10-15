interface Operation {
  parameters?: { name?: string; in?: string }[];
}

/**
 * Each operation that declares an `Idempotency-Key` header, as its method
 * and path template, in the document's order.
 */
export function keyedWrites(document: {
  paths: Record<string, Record<string, Operation>>;
}): [string, string][] {
  const keyed: [string, string][] = [];
  for (const [path, operations] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      const named = (operation.parameters ?? []).some(
        (parameter) =>
          parameter.in === "header" &&
          parameter.name?.toLowerCase() === "idempotency-key",
      );
      if (named) keyed.push([method.toUpperCase(), path]);
    }
  }
  return keyed;
}
