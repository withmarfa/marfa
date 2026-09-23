import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SHIPPED_EDGE_TYPE_SHAPES } from "../generated/edge-type-registry.js";
import { SHIPPED_TYPE_SHAPES } from "../generated/type-registry.js";
import { DIGEST_FILE, shapesDigest } from "../scripts/shapes-digest.js";

/** A copy of one family with one entry's shape changed. */
function moved(family: Record<string, unknown>): Record<string, unknown> {
  const [first] = Object.keys(family);
  return { ...family, [String(first)]: { moved: true } };
}

describe("the shipped shapes' committed digest", () => {
  it("matches the shapes this tree ships", () => {
    // Read off the disk, never recomputed: the committed digest is the half
    // a reviewer sees change beside a shape.
    const committed = readFileSync(DIGEST_FILE, "utf8").trim();
    expect(committed).toMatch(/^[0-9a-f]{64}$/);
    expect(
      shapesDigest(),
      "A shipped type or edge type changed shape. If that is intended, run `pnpm --filter @withmarfa/types shapes:digest` and commit the digest beside the change.",
    ).toBe(committed);
  });

  it("moves when either family's shapes do", () => {
    // The witness that the comparison above can fail, for both families.
    const shipped = {
      types: SHIPPED_TYPE_SHAPES,
      edges: SHIPPED_EDGE_TYPE_SHAPES,
    };
    const committed = readFileSync(DIGEST_FILE, "utf8").trim();
    expect(shapesDigest({ ...shipped, types: moved(shipped.types) })).not.toBe(
      committed,
    );
    expect(shapesDigest({ ...shipped, edges: moved(shipped.edges) })).not.toBe(
      committed,
    );
  });
});
