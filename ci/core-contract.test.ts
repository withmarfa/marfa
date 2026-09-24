import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contractVersionOf } from "../packages/client/scripts/contract-version.js";

/**
 * The core keeps its own transport rather than the generated client, so the
 * contract it holds a server to is a number written into it by
 * `scripts/generate-core-contract.ts`. The freshness job reruns that script;
 * this holds the number to the document whatever the script does.
 */
describe("the contract the core is built for", () => {
  it("is the one the document states", () => {
    const document = JSON.parse(
      readFileSync(new URL("../openapi.json", import.meta.url), "utf8"),
    ) as { info: { version: string } };
    const source = readFileSync(
      new URL("../core/marfa-core/src/contract.rs", import.meta.url),
      "utf8",
    );
    const stated = /^pub const CONTRACT_VERSION: u64 = (\d+);$/m.exec(source);
    expect(stated, "contract.rs states no CONTRACT_VERSION").not.toBeNull();
    expect(Number(stated?.[1])).toBe(contractVersionOf(document.info.version));
  });
});
