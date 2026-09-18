import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext(
    "compliance",
    "type-identifier-validation",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("type identifier validation on item creation", () => {
  it("accepts a two-part type identifier (core.bookmark)", async () => {
    const r = await client.createItem({
      type: "core.bookmark",
      properties: {
        url: "https://example.com",
        title: "Two-part type identifier",
      },
      source: ctx.source,
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe(201);
    trackItem(ctx, r.data.item.id);
  });

  it("accepts a three-part app-namespaced type identifier (app.example.bookmark)", async () => {
    // Five-tier namespace grammar: three-segment IDs are reserved for
    // `app.<app-name>.<type>`. The identifier clears the grammar gate; being
    // unregistered, the create stops at the registration gate with
    // `unknown_type` (not `invalid_type`), confirming the grammar accepted the
    // three-segment app form. Register via POST /types to create items of it.
    const r = await client.createItem({
      type: "app.example.bookmark",
      properties: {
        url: "https://example.com",
        title: "Three-part type identifier",
        description: "Testing three-segment namespace",
      },
      source: ctx.source,
    });
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("unknown_type");
  });

  it("rejects a non-tiered three-part type identifier (com.example.bookmark)", async () => {
    // `com.example.bookmark` is a `<publisher>.<type>.<subtype>` form the
    // grammar accepts (com is a non-reserved publisher root). It is
    // unregistered, so the create is rejected at the registration gate with
    // `unknown_type` rather than persisting an ad-hoc type.
    const r = await client.createItem({
      type: "com.example.bookmark",
      properties: { url: "https://example.com" },
      source: ctx.source,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("unknown_type");
  });

  it("rejects a one-part type identifier (bookmark)", async () => {
    const r = await client.createItem({
      type: "bookmark",
      source: ctx.source,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("invalid_type");
  });

  it("rejects uppercase characters in type identifier (Core.Bookmark)", async () => {
    const r = await client.createItem({
      type: "Core.Bookmark",
      source: ctx.source,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("invalid_type");
  });

  it("accepts underscores in type identifier segments (eval.custom_type)", async () => {
    // Underscores are valid within a segment — the grammar accepts
    // `eval.custom_type`. Unregistered, so the create stops at the
    // registration gate with `unknown_type`, confirming grammar acceptance.
    const r = await client.createItem({
      type: "eval.custom_type",
      properties: { title: "Underscore test" },
      source: ctx.source,
    });
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("unknown_type");
  });

  it("accepts hyphens in type identifier segments (local.my-custom-type)", async () => {
    // Hyphens are valid within a segment — the grammar accepts
    // `local.my-custom-type`. Unregistered, so the create stops at the
    // registration gate with `unknown_type`, confirming grammar acceptance.
    const r = await client.createItem({
      type: "local.my-custom-type",
      source: ctx.source,
    });
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("unknown_type");
  });

  it("accepts community type format (acme.deal)", async () => {
    // `acme.deal` is a well-formed `<publisher>.<type>` identifier. The
    // grammar accepts it; unregistered, the create stops at the registration
    // gate with `unknown_type`, confirming grammar acceptance.
    const r = await client.createItem({
      type: "acme.deal",
      properties: { title: "Community type test" },
      source: ctx.source,
    });
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("unknown_type");
  });

  it("rejects slash-separated type identifiers", async () => {
    const r = await client.createItem({
      type: "acme/deal",
      properties: { title: "Should fail" },
      source: ctx.source,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("invalid_type");
  });
});
