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
    // happened and that kept what the door does declare.
    expect(r.data.item.capture_latitude).toBe(999);

    // And it is not there on a later read either. The create answer and
    // the read are built by different code — the door's own return shape
    // and `rowToItem` — so these are two claims rather than one repeated.
    const read = await client.getItem(r.data.item.id);
    expect(read.ok).toBe(true);
    expect(read.data.item).not.toHaveProperty("device");
    expect(read.data.item.capture_latitude).toBe(999);

    // The second witness, and the one the absences rest on: the strict
    // door refuses the key *by name*. The status alone would not do it —
    // a PATCH the door finds empty answers `400 validation_error` too, so
    // a body that never carried the key would satisfy a status-only
    // assertion. Hence the name in the detail, alongside a change the
    // door would otherwise accept. A refusal naming the key is
    // unreachable unless the key travels, so the client is not dropping
    // it before the request leaves.
    const refused = await client.rawRequest<unknown>(
      `/items/${r.data.item.id}`,
      {
        method: "PATCH",
        body: {
          version: r.data.item.version,
          properties: { title: "still a note" },
          device: label,
        },
      },
    );
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    const errors = refused.error?.error.details?.errors as
      { message: string }[] | undefined;
    expect(errors?.some((e) => e.message.includes("device"))).toBe(true);
  });

  it("device: the filter grammar no longer knows the name", async () => {
    // The one thing that ever consulted the field. It was a system field
    // in the query grammar, so `filter=device eq "X"` filtered the column
    // it sat in. With the column gone the name is unknown, and the
    // grammar says so rather than degrading to a property lookup that
    // quietly matches nothing.
    const refused = await client.listItems({ filter: 'device eq "anything"' });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    expect(refused.error?.error.message).toContain("device");

    // The witness. A name the grammar does know filters on the same door
    // in the same run, so the refusal is about the name and not about the
    // door, the credential or the shape of the expression.
    const accepted = await client.listItems({ filter: "version gte 1" });
    expect(accepted.ok).toBe(true);
  });
});
