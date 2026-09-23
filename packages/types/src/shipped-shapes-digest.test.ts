import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DIGEST_FILE, shapesDigest } from "../scripts/shapes-digest.js";

describe("the shipped shapes' committed digest", () => {
  it("matches the shapes this tree ships", () => {
    const committed = readFileSync(DIGEST_FILE, "utf8").trim();
    expect(
      shapesDigest(),
      "A shipped type or edge type changed shape. If that is intended, run `pnpm --filter @withmarfa/types shapes:digest` and commit the digest beside the change.",
    ).toBe(committed);
  });
});
