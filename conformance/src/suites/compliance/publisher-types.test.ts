/**
 * Conformance for publisher-namespaced types.
 *
 * Publisher handles cannot collide with reserved roots; the namespace
 * grammar enforces exactly two segments for `<publisher>.<type>`.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { TestContext } from "../../client/types.js";
import { MarfaClient } from "../../client/api.js";
import { createTestContext, cleanup } from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "publisher-types"));
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("publisher types", () => {
  it("accepts a two-segment publisher type identifier", async () => {
    const r = await client.createItem({
      type: "acme.deal",
      properties: {},
    });
    // Named gate, not merely "some rejection". The two create-time gates run
    // in order — grammar, then registration — so stopping at the registration
    // gate is what proves the grammar accepted the identifier. A test happy
    // with any failure would keep passing if the grammar started rejecting
    // publisher ids outright, which is the thing it exists to catch.
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("unknown_type");
  });

  it("reserved-root prefix-match heuristic does not false-positive", async () => {
    // `core-pub`, `system-pub` and the rest are NOT the reserved roots — the
    // hyphen makes them ordinary publisher handles. Each therefore clears the
    // grammar gate and stops at the registration one, which is the assertion
    // with teeth: a prefix-match heuristic that started firing on these would
    // reject at the grammar gate instead, and only naming the gate catches it.
    for (const reserved of ["core", "system", "app", "user", "marfa"]) {
      const r = await client.createItem({
        type: `${reserved}-pub.deal`,
        properties: {},
      });
      expect(r.status).toBe(400);
      expect(r.error?.error.code).toBe("unknown_type");
    }
  });
});
