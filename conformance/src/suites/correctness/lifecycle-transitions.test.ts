import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext(
    "correctness",
    "lifecycle-transitions",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("lifecycle transitions", () => {
  it("note starts in active state", async () => {
    const note = createNote({ source: ctx.source });
    const r = await client.createItem(note);
    expect(r.ok).toBe(true);
    expect(r.data.item.state).toBe("active");
    trackItem(ctx, r.data.item.id);
  });

  it("transitions note from active to archived", async () => {
    const note = createNote({ source: ctx.source });
    const r = await client.createItem(note);
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    const archived = await client.transitionItem(r.data.item.id, "archived");
    expect(archived.ok).toBe(true);
    await expectMatchesSchema(
      "POST",
      "/items/{id}/transition",
      200,
      archived.data,
    );
    expect(archived.data.item.state).toBe("archived");
  });

  it("rejects a state outside the enum", async () => {
    const note = createNote({ source: ctx.source });
    const r = await client.createItem(note);
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    // A value outside the state enum is a body-shape refusal, not a
    // transition refusal.
    const invalid = await client.transitionItem(r.data.item.id, "nonexistent");
    expect(invalid.status).toBe(400);
    expect(invalid.error?.error.code).toBe("validation_error");
  });

  it("item can be created with a specified initial state", async () => {
    const note = createNote({
      source: ctx.source,
      state: "active",
    });
    const r = await client.createItem(note);
    expect(r.ok).toBe(true);
    expect(r.data.item.state).toBe("active");
    trackItem(ctx, r.data.item.id);
  });

  it("state filter works on listItems", async () => {
    const note = createNote({ source: ctx.source });
    const r = await client.createItem(note);
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    const activeItems = await client.listItems({
      state: "active",
      type: "core.note",
      limit: 100,
    });
    expect(activeItems.ok).toBe(true);
    const found = activeItems.data.data.some((i) => i.id === r.data.item.id);
    expect(found).toBe(true);

    const other = await client.createItem(createNote({ source: ctx.source }));
    expect(other.ok).toBe(true);
    trackItem(ctx, other.data.item.id);
    expect(
      (await client.transitionItem(other.data.item.id, "archived")).ok,
    ).toBe(true);

    const archivedItems = await client.listItems({
      state: "archived",
      type: "core.note",
      source: ctx.source,
      limit: 100,
    });
    expect(archivedItems.ok).toBe(true);
    const archivedIds = archivedItems.data.data.map((i) => i.id);
    expect(archivedIds).toContain(other.data.item.id);
    expect(archivedIds).not.toContain(r.data.item.id);
  });
});
