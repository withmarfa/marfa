/**
 * One digest of every shipped definition's shape: the enum values, fields,
 * requiredness, parents, roles, cardinalities and constraints that
 * `SHIPPED_TYPE_SHAPES` and `SHIPPED_EDGE_TYPE_SHAPES` carry as literal
 * types, with the prose left out.
 *
 * No package that reads them is published, so no surface lock sees them
 * move. The digest is committed in `shipped-shapes.sha256` instead, and
 * `src/shipped-shapes-digest.test.ts` refuses a tree whose shapes differ from
 * it: a changed shape passes only with the digest changed beside it, in the
 * same diff a reviewer reads.
 *
 * usage: tsx scripts/shapes-digest.ts --write
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SHIPPED_EDGE_TYPE_SHAPES } from "../generated/edge-type-registry.js";
import { SHIPPED_TYPE_SHAPES } from "../generated/type-registry.js";

/** The generator writes every key in code-unit order, so the text is stable. */
export function shapesDigest(): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        types: SHIPPED_TYPE_SHAPES,
        edges: SHIPPED_EDGE_TYPE_SHAPES,
      }),
    )
    .digest("hex");
}

export const DIGEST_FILE = fileURLToPath(
  new URL("../shipped-shapes.sha256", import.meta.url),
);

if (process.argv.includes("--write")) {
  writeFileSync(DIGEST_FILE, `${shapesDigest()}\n`);
}
