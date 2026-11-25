import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  cleanup,
  newRunId,
} from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext(
    "correctness",
    "upsert-state-tags",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

type Door = "POST /items" | "POST /items/bulk";
const DOORS: Door[] = ["POST /items", "POST /items/bulk"];

async function seed(sourceId: string, tags?: string[]) {
  const made = await client.createItem({
    type: "core.note",
    source: ctx.source,
    source_id: sourceId,
    properties: { body: "seeded" },
    ...(tags === undefined ? {} : { tags }),
  });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  trackItem(ctx, made.data.item.id);
  return made.data.item;
}

async function upsert(
  door: Door,
  sourceId: string,
  fields: { body: string; state?: string; tags?: string[] },
): Promise<{ id: string; updated: boolean }> {
  const entry = {
    type: "core.note",
    source: ctx.source,
    source_id: sourceId,
    properties: { body: fields.body },
    ...(fields.state === undefined ? {} : { state: fields.state }),
    ...(fields.tags === undefined ? {} : { tags: fields.tags }),
  };
  if (door === "POST /items") {
    const sent = await client.createItem(entry);
    expect(sent.status, JSON.stringify(sent.error)).toBe(200);
    return { id: sent.data.item.id, updated: sent.data.acknowledged !== true };
  }
  const sent = await client.bulkItems({ items: [entry], mode: "upsert" });
  expect(sent.status, JSON.stringify(sent.error)).toBe(200);
  const result = sent.data.results[0]!;
  expect(result.outcome, JSON.stringify(result)).toBe("updated");
  expect(sent.data.counts.updated).toBe(1);
  return { id: result.id!, updated: true };
}

async function stored(id: string) {
  const got = await client.getItem(id);
  expect(got.status, JSON.stringify(got.error)).toBe(200);
  return got.data;
}

describe("a natural-key upsert", () => {
  it("ignores the state it names on POST /items and on POST /items/bulk, an archived item included", async () => {
    for (const door of DOORS) {
      const run = newRunId();

      const active = await seed(`state-active-${run}`);
      const onActive = await upsert(door, `state-active-${run}`, {
        body: "upserted",
        state: "archived",
      });
      expect(onActive.id).toBe(active.id);
      const activeBack = await stored(active.id);
      expect(activeBack.item.properties.body, door).toBe("upserted");
      expect(activeBack.item.state, door).toBe("active");

      const archived = await seed(`state-archived-${run}`);
      expect(
        (await client.transitionItem(archived.id, "archived")).status,
      ).toBe(200);
      const onArchived = await upsert(door, `state-archived-${run}`, {
        body: "upserted",
        state: "active",
      });
      expect(onArchived.id).toBe(archived.id);
      const archivedBack = await stored(archived.id);
      expect(archivedBack.item.properties.body, door).toBe("upserted");
      expect(archivedBack.item.state, door).toBe("archived");

      const withoutState = await upsert(door, `state-archived-${run}`, {
        body: "again",
      });
      expect(withoutState.id).toBe(archived.id);
      const againBack = await stored(archived.id);
      expect(againBack.item.properties.body, door).toBe("again");
      expect(againBack.item.state, door).toBe("archived");
    }
  });

  it("updates an archived item in place on POST /items and on POST /items/bulk, as it updates an active one", async () => {
    for (const door of DOORS) {
      const sourceId = `update-archived-${newRunId()}`;
      const item = await seed(sourceId);
      expect((await client.transitionItem(item.id, "archived")).status).toBe(
        200,
      );
      const before = (await stored(item.id)).item.version;

      const sent = await upsert(door, sourceId, { body: "updated in place" });
      expect(sent.id, door).toBe(item.id);
      expect(sent.updated, door).toBe(true);
      const after = await stored(item.id);
      expect(after.item.properties.body, door).toBe("updated in place");
      expect(after.item.version, door).toBe(before + 1);
    }
  });

  it("replaces the tags of an item with the tags it names, removing a tag a person added, on POST /items and on POST /items/bulk", async () => {
    for (const door of DOORS) {
      const run = newRunId();
      const sourceId = `tags-${run}`;
      const item = await seed(sourceId, ["from-connector"]);
      const added = await client.addTags(item.id, ["from-person"]);
      expect(added.status, JSON.stringify(added.error)).toBe(200);
      expect([...(await stored(item.id)).metadata.tags].sort()).toEqual([
        "from-connector",
        "from-person",
      ]);

      // The witness: an upsert naming no tags keeps the person's tag.
      await upsert(door, sourceId, { body: "quiet" });
      expect([...(await stored(item.id)).metadata.tags].sort()).toEqual([
        "from-connector",
        "from-person",
      ]);

      await upsert(door, sourceId, {
        body: "named",
        tags: ["from-connector", `renamed-${run}`],
      });
      expect([...(await stored(item.id)).metadata.tags].sort(), door).toEqual(
        ["from-connector", `renamed-${run}`].sort(),
      );
    }
  });

  it("replaces the tags of an archived item with the tags it names, as it does for an active one", async () => {
    for (const door of DOORS) {
      const run = newRunId();
      const sourceId = `tags-archived-${run}`;
      const item = await seed(sourceId, ["from-connector"]);
      expect((await client.addTags(item.id, ["from-person"])).status).toBe(200);
      expect((await client.transitionItem(item.id, "archived")).status).toBe(
        200,
      );

      await upsert(door, sourceId, { body: "named", tags: ["only"] });
      const back = await stored(item.id);
      expect(back.metadata.tags, door).toEqual(["only"]);
      expect(back.item.state, door).toBe("archived");
    }
  });
});
