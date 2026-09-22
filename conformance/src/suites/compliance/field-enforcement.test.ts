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

  it("device: no such field ships, and a body naming one stores nothing", async () => {
    // `device` was a reserved field the wire accepted, the store wrote,
    // the version store copied and every read echoed \u2014 and that nothing
    // ever read. A field no code consults is not a feature held in
    // reserve; it is a column whose meaning each reader decides alone.
    //
    // **Stripped rather than refused, and that is the create door's
    // rule rather than this field's.** The create body is `z.object`,
    // so Zod drops a key it does not declare; `PATCH /items/{id}` is
    // `z.strictObject` and refuses one (`items.md` 47). No decided line
    // moves the create door, so removing the field puts `device` in the
    // same position as any other name the door never knew.
    const r = await client.createItem({
      ...createNote(),
      device: "random-device-xyz-\u{1F3B2}",
    } as Parameters<typeof client.createItem>[0]);
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    expect(r.data.item).not.toHaveProperty("device");

    // And it is not there on a later read either, so nothing stored it
    // out of sight of the create response.
    const read = await client.getItem(r.data.item.id);
    expect(read.ok).toBe(true);
    expect(read.data.item).not.toHaveProperty("device");
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
