/**
 * `data-*` attributes from a plain record, for the browser module that reads a
 * part. A key is the attribute name without its `data-` prefix.
 */
export function dataAttributes(
  data: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(data ?? {}).map(([key, value]) => [`data-${key}`, value]),
  );
}
