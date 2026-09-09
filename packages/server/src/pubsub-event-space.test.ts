/**
 * An event is addressed to the space its row belongs to, at every door.
 *
 * Doors take the space from the calling credential, and a caller's space is
 * its rows' space right up until it is not. The operator key is not
 * space-bound, so every door published unscoped whenever it wrote to
 * another account's rows — the bulk runner, `DELETE /items/{id}/purge`,
 * restore, transition, all of them.
 *
 * An unscoped event is not a broadly-delivered one. `subscribe` drops an
 * event whose space does not match a space-bound subscriber's, so the account
 * whose rows were written was the one account not told, while the unscoped
 * caller received everything. Proven live before the fix: purging two rows as
 * the operator key put both `item.purged` frames on its own stream and none
 * on the owner's.
 *
 * **A test that publishes as the space's own owner passes either way**, which
 * is why the door was believed correct for as long as it was: the two spaces
 * are the same value then. The cross-account case is the whole point.
 */
import { describe, expect, it } from "vitest";
import { publish, publishEdge, subscribe, subscribeEdges } from "./pubsub.js";
import type { Edge, Item } from "@withmarfa/shared";

const OWNER = "spc_owner";

function itemIn(space: string | null, id: string): Item {
  return {
    id,
    type: "core.note",
    state: "active",
    tier: "library",
    properties: { title: id },
    space_id: space,
    source: "web",
    version: 1,
    schema_version: 1,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    timestamp: "2026-01-01T00:00:00Z",
  } as unknown as Item;
}

/** Take the next frame a subscriber receives, or nothing within the window. */
async function nextFor(
  spaceId: string | undefined,
  fire: () => Promise<unknown>,
): Promise<Item | null> {
  const ac = new AbortController();
  const it = subscribe({ ...(spaceId && { spaceId }), signal: ac.signal })[
    Symbol.asyncIterator
  ]();
  const pending = it.next();
  await fire();
  const settled = await Promise.race([
    pending.then((r) => (r.done ? null : r.value.item)),
    new Promise<null>((r) => {
      setTimeout(() => {
        r(null);
      }, 300);
    }),
  ]);
  ac.abort();
  return settled;
}

describe("an event reaches the space its row lives in", () => {
  it("reaches the owner when an unscoped caller writes to their row", async () => {
    // The admin shape: the door has no space of its own to declare.
    const seen = await nextFor(OWNER, () =>
      publish({ type: "purged", item: itemIn(OWNER, "itm_admin_purge") }),
    );
    expect(seen?.id).toBe("itm_admin_purge");
  });

  it("still reaches the owner when the owner writes it, which is the case that always worked", async () => {
    const seen = await nextFor(OWNER, () =>
      publish({
        type: "purged",
        item: itemIn(OWNER, "itm_owner_purge"),
        spaceId: OWNER,
      }),
    );
    expect(seen?.id).toBe("itm_owner_purge");
  });

  it("does not reach a different space", async () => {
    const seen = await nextFor("spc_other", () =>
      publish({ type: "purged", item: itemIn(OWNER, "itm_not_yours") }),
    );
    expect(seen).toBeNull();
  });

  it("keeps the caller's space for a row that has none", async () => {
    // The single-space shape. The row carries no space, so the declared one
    // is all there is, and an unscoped subscriber is who wants it.
    const seen = await nextFor(OWNER, () =>
      publish({
        type: "purged",
        item: itemIn(null, "itm_spaceless"),
        spaceId: OWNER,
      }),
    );
    expect(seen?.id).toBe("itm_spaceless");
  });

  it("does the same for an edge", async () => {
    const ac = new AbortController();
    const it = subscribeEdges({ spaceId: OWNER, signal: ac.signal })[
      Symbol.asyncIterator
    ]();
    const pending = it.next();
    await publishEdge({
      type: "edge_deleted",
      edge: { id: "edg_1", space_id: OWNER } as unknown as Edge,
    });
    const seen = await Promise.race([
      pending.then((r) => (r.done ? null : r.value.edge.id)),
      new Promise<null>((r) => {
        setTimeout(() => {
          r(null);
        }, 300);
      }),
    ]);
    ac.abort();
    expect(seen).toBe("edg_1");
  });
});
