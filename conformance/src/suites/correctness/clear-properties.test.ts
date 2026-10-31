import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { ConflictResponse, TestContext } from "../../client/types.js";
import { cleanup, createTestContext, trackItem } from "../../utils/setup.js";
import { createMessage, createNote } from "../../generators/items.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext(
    "correctness",
    "clear-properties",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function note(properties: Record<string, unknown>) {
  const made = await client.createItem(
    createNote({ source: ctx.source, properties }),
  );
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  trackItem(ctx, made.data.item.id);
  return made.data.item;
}

describe("clearing named properties", () => {
  it("removes each property it names and keeps every other", async () => {
    const item = await note({
      title: "Kept",
      body: "Kept",
      notes: "To clear",
      due: "2026-11-01",
      courier: { nested: ["undeclared", 1] },
    });

    const cleared = await client.updateItem(item.id, {
      clear_properties: ["notes", "due"],
      version: item.version,
    });
    expect(cleared.status, JSON.stringify(cleared.error)).toBe(200);
    await expectMatchesSchema("PATCH", "/items/{id}", 200, cleared.data);
    expect(cleared.data.item.properties).toEqual({
      title: "Kept",
      body: "Kept",
      courier: { nested: ["undeclared", 1] },
    });
    expect(cleared.data.item.version).toBe(item.version + 1);

    const fetched = await client.getItem(item.id);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.item.properties).toEqual(cleared.data.item.properties);
  });

  it("clears beside the properties it sets, and takes a name the item lacks as done", async () => {
    const item = await note({ title: "Before", body: "Kept", notes: "Gone" });

    const written = await client.updateItem(item.id, {
      properties: { title: "After" },
      clear_properties: ["notes", "never-held"],
      version: item.version,
    });
    expect(written.status, JSON.stringify(written.error)).toBe(200);
    expect(written.data.item.properties).toEqual({
      title: "After",
      body: "Kept",
    });

    // Clearing only what is already gone still answers as an update does.
    const again = await client.updateItem(item.id, {
      clear_properties: ["notes"],
      version: written.data.item.version,
    });
    expect(again.status, JSON.stringify(again.error)).toBe(200);
    expect(again.data.item.properties).toEqual({
      title: "After",
      body: "Kept",
    });
  });

  it("refuses a property both set and cleared, and writes nothing", async () => {
    const item = await note({ title: "Kept", body: "Kept", notes: "Kept" });

    const both = await client.updateItem(item.id, {
      properties: { notes: "New" },
      clear_properties: ["notes"],
      version: item.version,
    });
    expect(both.status).toBe(400);
    expect(both.error?.error.code).toBe("validation_error");
    expect(both.error?.error.details).toMatchObject({
      clear_properties: ["notes"],
    });

    const fetched = await client.getItem(item.id);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.item.version).toBe(item.version);
    expect(fetched.data.item.properties.notes).toBe("Kept");
  });

  it("refuses an empty name, as it refuses an empty property name", async () => {
    const item = await note({ title: "Kept", body: "Kept" });

    const empty = await client.updateItem(item.id, {
      clear_properties: [""],
      version: item.version,
    });
    expect(empty.status).toBe(400);
    expect(empty.error?.error.code).toBe("validation_error");
  });

  it("refuses an empty clear_properties alone as a write of nothing", async () => {
    const item = await note({ title: "Kept", body: "Kept" });

    const nothing = await client.updateItem(item.id, {
      clear_properties: [],
      version: item.version,
    });
    expect(nothing.status).toBe(400);
    expect(nothing.error?.error.code).toBe("validation_error");

    // The witness: a non-empty list alone is a write.
    const something = await client.updateItem(item.id, {
      clear_properties: ["body"],
      version: item.version,
    });
    expect(something.status, JSON.stringify(something.error)).toBe(200);
  });

  it("refuses clearing a field the type requires, and clears an optional one", async () => {
    const made = await client.createItem(
      createMessage({
        source: ctx.source,
        properties: { from: "Sender", body: "Body", to: ["Recipient"] },
      }),
    );
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    trackItem(ctx, made.data.item.id);

    const required = await client.updateItem(made.data.item.id, {
      clear_properties: ["from"],
      version: made.data.item.version,
    });
    expect(required.status).toBe(400);
    expect(required.error?.error.code).toBe("invalid_properties");

    // The witness: the same write on an optional field lands.
    const optional = await client.updateItem(made.data.item.id, {
      clear_properties: ["to"],
      version: made.data.item.version,
    });
    expect(optional.status, JSON.stringify(optional.error)).toBe(200);
    expect(optional.data.item.properties).toEqual({
      from: "Sender",
      body: "Body",
    });
  });

  it("refuses a stale clear under version_match exact", async () => {
    const item = await note({ title: "Kept", body: "Kept", notes: "Kept" });
    const advanced = await client.updateItem(item.id, {
      properties: { title: "Since" },
      version: item.version,
    });
    expect(advanced.ok).toBe(true);

    const stale = await client.updateItem(item.id, {
      clear_properties: ["notes"],
      version: item.version,
      version_match: "exact",
    });
    expect(stale.status).toBe(409);
    expect(stale.error?.error.code).toBe("version_conflict");

    const fetched = await client.getItem(item.id);
    expect(fetched.data.item.properties.notes).toBe("Kept");
  });
});

describe("clearing at a stale version", () => {
  it("clears a property nobody changed since, keeping what others wrote", async () => {
    const item = await note({ title: "Original", body: "Kept", notes: "Mine" });
    const advanced = await client.updateItem(item.id, {
      properties: { title: "Server title" },
      version: item.version,
    });
    expect(advanced.ok).toBe(true);
    // The witness: the property is there to be cleared.
    expect(advanced.data.item.properties.notes).toBe("Mine");

    const stale = await client.updateItem(item.id, {
      clear_properties: ["notes"],
      version: item.version,
    });
    expect(stale.status, JSON.stringify(stale.error)).toBe(200);
    expect(stale.data.item.properties).toEqual({
      title: "Server title",
      body: "Kept",
    });
    expect(stale.data.item.version).toBe(3);
  });

  it("refuses clearing a property another writer changed since, and clears nothing", async () => {
    const item = await note({ title: "Original", body: "Kept", notes: "Mine" });
    const advanced = await client.updateItem(item.id, {
      properties: { notes: "Changed since" },
      version: item.version,
    });
    expect(advanced.ok).toBe(true);

    const stale = await client.updateItem(item.id, {
      clear_properties: ["notes"],
      version: item.version,
    });
    expect(stale.status).toBe(409);
    expect(stale.error?.error.code).toBe("version_conflict");
    const body = stale.error as unknown as ConflictResponse;
    expect(body.conflicting_fields).toEqual(["notes"]);

    const fetched = await client.getItem(item.id);
    expect(fetched.data.item.version).toBe(2);
    expect(fetched.data.item.properties.notes).toBe("Changed since");
  });

  it("answers a clear naming a version no snapshot covers ancestor_unavailable, and clears nothing", async () => {
    const item = await note({ title: "Kept", body: "Kept", notes: "Kept" });

    const unknown = await client.updateItem(item.id, {
      clear_properties: ["notes"],
      version: item.version + 50,
    });
    expect(unknown.status).toBe(409);
    expect(unknown.error?.error.code).toBe("ancestor_unavailable");

    const fetched = await client.getItem(item.id);
    expect(fetched.data.item.version).toBe(item.version);
    expect(fetched.data.item.properties.notes).toBe("Kept");
  });

  it("leaves a property the version it names never held", async () => {
    const item = await note({ title: "Original", body: "Kept" });
    const added = await client.updateItem(item.id, {
      properties: { notes: "Added since" },
      version: item.version,
    });
    expect(added.ok).toBe(true);

    const stale = await client.updateItem(item.id, {
      properties: { title: "Mine" },
      clear_properties: ["notes"],
      version: item.version,
    });
    expect(stale.status, JSON.stringify(stale.error)).toBe(200);
    expect(stale.data.item.properties).toEqual({
      title: "Mine",
      body: "Kept",
      notes: "Added since",
    });
  });
});
