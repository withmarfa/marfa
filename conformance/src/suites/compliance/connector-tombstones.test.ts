import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { cleanup, createTestContext, trackItem } from "../../utils/setup.js";

/**
 * What a connector can count on when a vendor entry names a key a purge left
 * a tombstone for: the server takes the write whatever the tombstone's time,
 * and the decision to write is the connector's.
 */
let client: MarfaClient;
let ctx: TestContext;
let linked: string;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext(
    "compliance",
    "connector-tombstones",
  ));
  linked = `user.vendortomb-${ctx.runId}`;
  const registered = await client.registerType({
    id: linked,
    fields: { vendor_id: { type: "string" } },
    link_field: "vendor_id",
  });
  expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("a vendor entry whose key a purge left a tombstone for", () => {
  it("is written as a new item, whether the tombstone's settled_at is the purge time or moved past it", async () => {
    const hour = 3_600_000;
    for (const [name, moveBy] of [
      ["at-purge", 0],
      ["moved", 48 * hour],
    ] as const) {
      const link = `entry-${name}-${ctx.runId}`;
      const key = `entry-${name}-key-${ctx.runId}`;
      const made = await client.createItem({
        type: linked,
        source: ctx.source,
        source_id: key,
        properties: { vendor_id: link },
      });
      expect(made.ok, JSON.stringify(made.error)).toBe(true);
      const purgedId = made.data.item.id;
      expect((await client.deleteItem(purgedId)).ok).toBe(true);
      expect((await client.purgeItem(purgedId)).ok).toBe(true);

      const byLink = { type: linked, links: [link] };
      const [tombstone] = (await client.lookupItems(byLink)).data.tombstones;
      // The witness: the purge left a tombstone, which the connector reads.
      expect(tombstone?.settled_at).toBe(tombstone?.purged_at);
      if (moveBy > 0) {
        const to = new Date(
          Date.parse(tombstone!.purged_at) + moveBy,
        ).toISOString();
        const settled = await client.settleTombstones({
          ...byLink,
          settled_at: to,
        });
        expect(settled.data.data.map((t) => t.settled_at)).toEqual([to]);
      }

      const again = await client.createItem({
        type: linked,
        source: ctx.source,
        source_id: key,
        properties: { vendor_id: link },
      });
      expect(again.status, JSON.stringify(again.error)).toBe(201);
      trackItem(ctx, again.data.item.id);
      expect(again.data.item.id).not.toBe(purgedId);
      const found = await client.lookupItems(byLink);
      expect(found.data.data.map((i) => i.id)).toEqual([again.data.item.id]);
      expect(found.data.tombstones).toEqual([]);
    }
  });
});
