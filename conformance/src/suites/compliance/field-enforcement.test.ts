import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext(
    "compliance",
    "field-enforcement",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("stamped, non-forgeable fields", () => {
  it("source: server stamps the credential source, client value is ignored", async () => {
    const r = await client.createItem({
      ...createNote(),
      source: "forged-source-value",
    });
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    expect(r.data.item.source).toBe(ctx.source);
    expect(r.data.item.source).not.toBe("forged-source-value");
  });
});

describe("client-supplied verbatim fields (preserved without validation)", () => {
  it("occurred_at: a specific ISO date is preserved", async () => {
    const ts = "2024-03-15T10:00:00.000Z";
    const r = await client.createItem({ ...createNote(), occurred_at: ts });
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    expect(r.data.item.occurred_at).toBe(ts);
  });

  it("occurred_at: a far-future ISO date is preserved", async () => {
    const ts = "2099-01-01T00:00:00.000Z";
    const r = await client.createItem({ ...createNote(), occurred_at: ts });
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    expect(r.data.item.occurred_at).toBe(ts);
  });

  it("occurred_at: a far-past ISO date is preserved", async () => {
    const ts = "1970-01-01T00:00:00.000Z";
    const r = await client.createItem({ ...createNote(), occurred_at: ts });
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    expect(r.data.item.occurred_at).toBe(ts);
  });

  it("device: a nonsense label is preserved verbatim", async () => {
    const device = "random-device-xyz-\u{1F3B2}";
    const r = await client.createItem({ ...createNote(), device });
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    expect(r.data.item.device).toBe(device);
  });

  it("capture coordinates are preserved verbatim, including out-of-range values", async () => {
    const r = await client.createItem({
      ...createNote(),
      capture_latitude: 999,
      capture_longitude: -9999,
    });
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    expect(r.data.item.capture_latitude).toBe(999);
    expect(r.data.item.capture_longitude).toBe(-9999);
  });
});
