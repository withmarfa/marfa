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

describe("a source the key was not given", () => {
  it("source: a body naming a source the key does not claim is refused, naming it", async () => {
    const refused = await client.createItem({
      ...createNote(),
      source: "forged-source-value",
    });
    expect(
      refused.status,
      "a body naming a source its key was never given was written, so any key can write rows that read as another's",
    ).toBe(403);
    expect(
      refused.error?.error.code,
      "the refusal is not the one a permission the caller lacks answers",
    ).toBe("forbidden");
    expect(
      refused.error?.error.details?.source,
      "the refusal does not name the source the body named",
    ).toBe("forged-source-value");

    // The witness. The same body naming the key's own source is written and
    // stamped with it, so the refusal is the source and not the body.
    const own = await client.createItem({
      ...createNote(),
      source: ctx.source,
    });
    expect(
      own.status,
      "the same body naming the key's own source was refused, so the refusal above says nothing about the source",
    ).toBe(201);
    trackItem(ctx, own.data.item.id);
    expect(
      own.data.item.source,
      "a body naming the key's own source was stamped with another",
    ).toBe(ctx.source);
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

describe("a field the wire does not declare", () => {
  it("device: no such field ships, and a body naming one is refused by name and stores nothing", async () => {
    const label = "random-device-xyz-\u{1F3B2}";
    const tag = `undeclared-device-${Math.random().toString(36).slice(2, 10)}`;

    // A refusal naming the key is unreachable unless the key travels, so
    // the client is not dropping it before the request leaves. The status
    // alone would not show that.
    const refused = await client.rawRequest<unknown>("/items", {
      method: "POST",
      body: { ...createNote(), tags: [tag], device: label },
    });
    expect(
      refused.status,
      "a create naming a field the door does not declare was answered as success",
    ).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    const createErrors = refused.error?.error.details?.errors as
      { message: string }[] | undefined;
    expect(
      createErrors?.some((e) => e.message.includes('"device"')),
      "the refusal does not name the field the caller got wrong",
    ).toBe(true);
    const listed = await client.listItems({ tags: [tag], state: "any" });
    expect(listed.ok).toBe(true);
    expect(
      listed.data.data,
      "the refused create stored an item anyway",
    ).toEqual([]);

    // The witness: the same body without the field is created and listed,
    // so the empty listing above is the refusal and not the listing.
    const r = await client.createItem({ ...createNote(), tags: [tag] });
    expect(r.status).toBe(201);
    trackItem(ctx, r.data.item.id);
    expect(r.data.item).not.toHaveProperty("device");
    const after = await client.listItems({ tags: [tag], state: "any" });
    expect(after.data.data.map((i) => i.id)).toEqual([r.data.item.id]);

    // The create answer and the read are built by different code, so these
    // are two claims rather than one repeated.
    const read = await client.getItem(r.data.item.id);
    expect(read.ok).toBe(true);
    expect(read.data.item).not.toHaveProperty("device");

    // The update door refuses it by name too, alongside a change it would
    // otherwise accept.
    const refusedUpdate = await client.rawRequest<unknown>(
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
    expect(refusedUpdate.status).toBe(400);
    expect(refusedUpdate.error?.error.code).toBe("validation_error");
    const updateErrors = refusedUpdate.error?.error.details?.errors as
      { message: string }[] | undefined;
    expect(updateErrors?.some((e) => e.message.includes('"device"'))).toBe(
      true,
    );
  });

  it("a key inside properties is the type's, and a create carrying one is written", async () => {
    const r = await client.createItem(
      createNote({
        properties: { title: "kept", body: "kept", device: "a property" },
      }),
    );
    expect(r.status).toBe(201);
    trackItem(ctx, r.data.item.id);
    expect(r.data.item.properties.device).toBe("a property");
  });

  it("device: the filter grammar does not know the name", async () => {
    // A name the grammar does not hold is refused rather than resolved
    // as a property, which is the half worth a case of its own: a filter
    // that resolved to a property nothing carries would answer an empty
    // page, and an empty page reads as a narrowing that matched nothing
    // rather than as a question the door could not ask.
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
