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

describe("fields the wire no longer declares", () => {
  it("device: no such field ships, and a body naming one stores nothing", async () => {
    // **Stripped rather than refused, and that is the create door's rule
    // rather than this field's.** The create body is `z.object`, so Zod
    // drops a key it does not declare; `PATCH /items/{id}` is
    // `z.strictObject` and refuses one (`items.md` 47). No decided line
    // moves the create door, so this name sits where any other name the
    // door never knew sits.
    const label = "random-device-xyz-\u{1F3B2}";
    const r = await client.createItem({
      ...createNote(),
      device: label,
      capture_latitude: 999,
    } as Parameters<typeof client.createItem>[0]);
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    expect(r.data.item).not.toHaveProperty("device");

    // The first witness: `capture_latitude` rode in the same body and came
    // back, so the create the absence is asserted about is a create that
    // happened and that kept what the door declares.
    expect(r.data.item.capture_latitude).toBe(999);

    // And it is not there on a later read either, so nothing stored it out
    // of sight of the create response.
    const read = await client.getItem(r.data.item.id);
    expect(read.ok).toBe(true);
    expect(read.data.item).not.toHaveProperty("device");
    expect(read.data.item.capture_latitude).toBe(999);

    // The second witness, and the one the absence rests on: the same key
    // on the strict door is refused. A refusal is only reachable if the
    // key travels, so the client is not quietly dropping it before the
    // request leaves and the assertions above are about the server.
    const refused = await client.rawRequest<unknown>(
      `/items/${r.data.item.id}`,
      {
        method: "PATCH",
        body: { version: r.data.item.version, device: label },
      },
    );
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
  });
});
