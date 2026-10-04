import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";
import { createNote, generateId } from "../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext(
    "correctness",
    "items-source-id-mutation",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("PATCH /items/:id source_id mutation", () => {
  it("refuses a move onto a natural key another row already holds", async () => {
    // The natural key is unique per source, so moving one row onto
    // another's key would leave two rows a connector's next re-sync cannot
    // tell apart. Refused rather than merged, and with its own code: a
    // caller retrying a rename needs to know the target is taken rather
    // than that its version was stale.
    const takenSourceId = `taken-${generateId()}`;
    const movingSourceId = `moving-${generateId()}`;

    const taken = await client.createItem(
      createNote({ source: ctx.source, source_id: takenSourceId }),
    );
    expect(taken.ok).toBe(true);
    trackItem(ctx, taken.data.item.id);

    const moving = await client.createItem(
      createNote({ source: ctx.source, source_id: movingSourceId }),
    );
    expect(moving.ok).toBe(true);
    trackItem(ctx, moving.data.item.id);

    const collided = await client.updateItem(moving.data.item.id, {
      source_id: takenSourceId,
      version: moving.data.item.version,
    });
    expect(collided.status).toBe(409);
    expect(collided.error?.error.code).toBe("source_id_conflict");

    // Nothing moved: both rows still answer under the keys they had.
    const after = await client.getItem(moving.data.item.id);
    expect(after.ok).toBe(true);
    expect(after.data.item.source_id).toBe(movingSourceId);
    const other = await client.getItem(taken.data.item.id);
    expect(other.ok).toBe(true);
    expect(other.data.item.source_id).toBe(takenSourceId);

    // The control: a key nothing holds is taken, so the refusal above is
    // the collision and not the door.
    const free = await client.updateItem(moving.data.item.id, {
      source_id: `free-${generateId()}`,
      version: moving.data.item.version,
    });
    expect(free.status).toBe(200);
  });

  it("refuses a move onto the natural key of a row in the bin", async () => {
    // The unique index counts a row in the bin, so its key is taken, and
    // the move is a conflict rather than a failure at the index.
    const heldSourceId = `binned-${generateId()}`;
    const holder = await client.createItem(
      createNote({ source: ctx.source, source_id: heldSourceId }),
    );
    expect(holder.ok).toBe(true);
    trackItem(ctx, holder.data.item.id);
    const moving = await client.createItem(
      createNote({ source: ctx.source, source_id: `moving-${generateId()}` }),
    );
    expect(moving.ok).toBe(true);
    trackItem(ctx, moving.data.item.id);

    // The witness: the same move onto the live holder is the refusal this
    // case expects, so the binned one is held to what a live row gets.
    const live = await client.updateItem(moving.data.item.id, {
      source_id: heldSourceId,
      version: moving.data.item.version,
    });
    expect(live.status).toBe(409);

    const binned = await client.deleteItem(holder.data.item.id);
    expect(binned.ok).toBe(true);
    const res = await client.updateItem(moving.data.item.id, {
      source_id: heldSourceId,
      version: moving.data.item.version,
    });
    expect(res.status).toBe(409);
    expect(res.error?.error.code).toBe("source_id_conflict");
  });

  it("mutates source_id, returns 200, and round-trips on subsequent GET", async () => {
    const originalSourceId = `original-${generateId()}`;
    const newSourceId = `mutated-${generateId()}`;

    const created = await client.createItem(
      createNote({ source: ctx.source, source_id: originalSourceId }),
    );
    expect(created.ok).toBe(true);
    const itemId = created.data.item.id;
    trackItem(ctx, itemId);
    expect(created.data.item.source_id).toBe(originalSourceId);

    const patched = await client.updateItem(itemId, {
      source_id: newSourceId,
      version: created.data.item.version,
    });
    expect(patched.ok).toBe(true);
    expect(patched.status).toBe(200);
    expect(patched.data.item.source_id).toBe(newSourceId);

    const fetched = await client.getItem(itemId);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.item.source_id).toBe(newSourceId);
  });
});
