import { readFileSync } from "node:fs";

/** The committed `openapi.json`, parsed once. */
export const document = JSON.parse(
  readFileSync(new URL("../../openapi.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

/**
 * Follow every local `$ref` in `node` to what it names. A reference met again
 * on the way down stays as it is, so a cycle ends instead of looping.
 */
export function inlineRefs(
  node: unknown,
  root: Record<string, unknown> = document,
  seen: ReadonlySet<string> = new Set(),
): unknown {
  if (Array.isArray(node)) {
    return node.map((child) => inlineRefs(child, root, seen));
  }
  if (node === null || typeof node !== "object") return node;
  const record = node as Record<string, unknown>;
  const ref = record.$ref;
  if (typeof ref === "string") {
    if (seen.has(ref)) return node;
    const target = ref
      .replace(/^#\//, "")
      .split("/")
      .reduce<unknown>(
        (carry, segment) =>
          carry === null || typeof carry !== "object"
            ? undefined
            : (carry as Record<string, unknown>)[
                segment.replace(/~1/g, "/").replace(/~0/g, "~")
              ],
        root,
      );
    if (target === undefined) {
      throw new Error(`The document has no ${ref} to resolve.`);
    }
    return inlineRefs(target, root, new Set([...seen, ref]));
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = inlineRefs(value, root, seen);
  }
  return out;
}
