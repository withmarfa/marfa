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
    const errors = invalid.error?.error.details?.errors as
      Array<{ path: string }> | undefined;
    expect(errors?.[0]?.path).toBe("state");
  });

  it("offers a canonical type three states, and not the fourth", async () => {
    // Four states exist, and a client that built its enum from this door
    // would get three. `revoked` is the fourth: a `system.*` type's
    // terminal state, on a lifecycle where `archived` and `trashed` do not
    // apply, and no state a canonical type reaches. This door is the
    // canonical lifecycle's, so `revoked` is outside the values it takes
    // and is refused as a body would be rather than as a move would be —
    // which is the same answer `nonexistent` gets above, and is why the
    // sentence naming the fourth state has to say where it lives.
    const r = await client.createItem(createNote({ source: ctx.source }));
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    const revoked = await client.transitionItem(r.data.item.id, "revoked");
    expect(revoked.status).toBe(400);
    expect(revoked.error?.error.code).toBe("validation_error");

    // The witness. The same door moves the same row to a state this
    // type's lifecycle does contain, so the refusal above is about
    // `revoked` and not about the door, the row or the credential.
    const archived = await client.transitionItem(r.data.item.id, "archived");
    expect(archived.ok).toBe(true);
    expect(archived.data.item.state).toBe("archived");
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

  it("refuses an initial state the type's lifecycle cannot reach, and stores one it can", async () => {
    const sourceId = `initial-state-${ctx.runId}`;
    const refused = await client.createItem(
      createNote({
        source: ctx.source,
        source_id: sourceId,
        state: "revoked",
      }),
    );
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");

    // Nothing was written: the same natural key lands as a new row.
    const archived = await client.createItem(
      createNote({
        source: ctx.source,
        source_id: sourceId,
        state: "archived",
      }),
    );
    expect(archived.status, JSON.stringify(archived.error)).toBe(201);
    trackItem(ctx, archived.data.item.id);
    expect(archived.data.item.state).toBe("archived");
    const read = await client.getItem(archived.data.item.id);
    expect(read.data.item.state).toBe("archived");
  });

  it("refuses a move to the state the row is in", async () => {
    const r = await client.createItem(createNote({ source: ctx.source }));
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    const same = await client.transitionItem(r.data.item.id, "active");
    expect(same.status).toBe(400);
    expect(same.error?.error.code).toBe("invalid_transition");

    // The witness: a move to a different state the graph allows is taken, so
    // the refusal above is about the state the row is in.
    const moved = await client.transitionItem(r.data.item.id, "archived");
    expect(moved.ok).toBe(true);
    expect(moved.data.item.state).toBe("archived");
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
