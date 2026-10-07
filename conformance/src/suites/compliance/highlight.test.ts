import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";
import { createHighlight } from "../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "highlight"));
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("core.highlight property-level", () => {
  it("creates with only the required text property", async () => {
    const r = await client.createItem({
      type: "core.highlight",
      properties: { text: "Only the required text." },
    });
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    expect(r.data.item.properties.text).toBe("Only the required text.");
  });

  it("roundtrips all optional properties", async () => {
    const r = await client.createItem(createHighlight());
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    const props = r.data.item.properties;
    expect(props.text).toBe("A memorable passage about distributed systems.");
    expect(props.color).toBe("yellow");
    expect(props.locator_type).toBe("offset");
    expect(props.start_location).toBe("100");
    expect(props.end_location).toBe("200");
  });

  it("accepts an optional note alongside text", async () => {
    const r = await client.createItem({
      type: "core.highlight",
      properties: {
        text: "The passage itself.",
        note: "Why this matters to me.",
      },
    });
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    expect(r.data.item.properties.note).toBe("Why this matters to me.");
  });

  it("rejects a highlight missing the required text property", async () => {
    const r = await client.createItem({
      type: "core.highlight",
      properties: { color: "yellow" },
    });
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("invalid_properties");
    const errors = r.error?.error.details?.errors as
      Array<{ field: string }> | undefined;
    expect(errors?.map((e) => e.field)).toContain("text");
  });

  it("accepts each locator_type variant", async () => {
    const variants = [
      "offset",
      "page",
      "time",
      "cfi",
      "order",
      "none",
    ] as const;
    for (const locator_type of variants) {
      const r = await client.createItem({
        type: "core.highlight",
        properties: {
          text: `locator variant ${locator_type}`,
          locator_type,
          start_location: "0",
          end_location: "10",
        },
      });
      expect(r.ok).toBe(true);
      trackItem(ctx, r.data.item.id);
      expect(r.data.item.properties.locator_type).toBe(locator_type);
    }
  });

  it("the moment the highlight was made is the system occurred_at", async () => {
    const ts = "2026-03-15T10:00:00.000Z";
    const r = await client.createItem({
      type: "core.highlight",
      properties: { text: "Timestamp check." },
      occurred_at: ts,
    });
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    expect(r.data.item.occurred_at).toBe(ts);
  });

  it("has no highlighted_at property on item or properties", async () => {
    const r = await client.createItem(createHighlight());
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    const props = r.data.item.properties as Record<string, unknown>;
    expect(props.highlighted_at).toBeUndefined();
    expect(
      (r.data.item as unknown as Record<string, unknown>).highlighted_at,
    ).toBeUndefined();
  });
});
