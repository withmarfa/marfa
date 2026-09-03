/**
 * Every door that writes an edge tells the stream about it.
 *
 * `POST /edges` and its two siblings published; nothing else did. Five
 * other routes create or remove edges, and `items.ts` — which reaches
 * three of them — did not import `publishEdge` at all. So whether a
 * relationship reached a second device depended on which door the writer
 * happened to use, and a client holding a graph drifted from the server
 * with nothing to repair it.
 *
 * **Asserted per door through a live subscriber.** A door's silence is
 * invisible from its own response: every one of these answered 2xx while
 * publishing nothing. The subscriber is the only place the difference
 * shows.
 *
 * The deletions matter more than the creations, and are the half a
 * create-only suite passes straight over. An edge pointing AT a purged
 * item lives on an item that is not being purged, so its holder is told
 * nothing by the item event — the edge event is the only signal it gets.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  collectEdgeEvents,
  collectItemEvents,
  nextEdgeEvent,
  settle,
  runBulkActionAsync,
} from "../test-utils.js";
import type { EdgeEventWithId } from "../pubsub.js";
import { seedStarterContent } from "../auth/starter-content.js";
import { generateId } from "@withmarfa/shared";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

async function note(body: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.adminKey,
    body: { type: "core.note", properties: { body } },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

/**
 * Watch the edge stream across `act` and return the events themselves.
 *
 * The full payloads, not just ids: a subscriber acts on the edge in the
 * frame, so a test that only checked ids would pass on an event carrying
 * an empty shell.
 *
 * `settle` is right here and only here — every assertion below this
 * helper is partly a negative one (that no *other* event arrived, or
 * that exactly N did), and "nothing else came" cannot be awaited.
 * Assertions that something specific arrives use `nextEdgeEvent`.
 */
async function edgeEventsDuring(
  act: () => Promise<void>,
): Promise<EdgeEventWithId[]> {
  const controller = new AbortController();
  const { events, done } = collectEdgeEvents(controller.signal);
  await settle();
  await act();
  await settle();
  controller.abort();
  await done;
  return events;
}

describe("edge events on every door", () => {
  it("POST /items announces the edges written with the item", async () => {
    const target = await note("inline-target");
    // Attached before the write and awaited after it, so the arrival is
    // the signal rather than a sleep long enough to hope for one.
    const announced = nextEdgeEvent(
      (e) => e.type === "edge_created" && e.edge.target_id === target,
    );

    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "inline-source" },
        edges: { references: [target] },
      },
    });
    expect(res.status).toBe(201);
    const parsed = (await res.json()) as {
      item: { id: string; edges?: Record<string, { edges: { id: string }[] }> };
    };
    const created = (parsed.item.edges?.references?.edges ?? []).map(
      (e) => e.id,
    );
    expect(created).toHaveLength(1);

    // The whole row rides the event. A subscriber that had to re-fetch to
    // learn the endpoints would defeat the point of announcing one.
    const event = await announced;
    expect(event.edge.id).toBe(created[0]);
    expect(event.edge.source_id).toBe(parsed.item.id);
    expect(event.edge.target_id).toBe(target);
    expect(event.edge.edge_type).toBe("references");
  });

  it("PATCH /items announces both halves of a replacement", async () => {
    const source = await note("patch-source");
    const first = await note("patch-target-1");
    const second = await note("patch-target-2");

    const seeded = await request(ctx.app, "PATCH", `/items/${source}`, {
      key: ctx.adminKey,
      body: { edges: { references: [first] } },
    });
    expect(seeded.status).toBe(200);
    const before = await request(ctx.app, "GET", `/items/${source}/edges`, {
      key: ctx.adminKey,
    });
    const oldEdgeId = ((await before.json()) as { data: { id: string }[] })
      .data[0]?.id;
    expect(oldEdgeId).toBeDefined();

    const heard = await edgeEventsDuring(async () => {
      const res = await request(ctx.app, "PATCH", `/items/${source}`, {
        key: ctx.adminKey,
        body: { edges: { references: [second] } },
      });
      expect(res.status).toBe(200);
    });

    // Replace-all is a delete and a create, and a subscriber needs both:
    // told only about the create it keeps a relationship that is gone.
    const removed = heard.filter(
      (e) => e.type === "edge_deleted" && e.edge.id === oldEdgeId,
    );
    expect(removed).toHaveLength(1);
    // The removed edge arrives whole. A frame carrying only an id would
    // leave a subscriber unable to tell which relationship it lost
    // without a lookup against a row that no longer exists.
    expect(removed[0]?.edge.source_id).toBe(source);
    expect(removed[0]?.edge.target_id).toBe(first);
    expect(removed[0]?.edge.edge_type).toBe("references");
    expect(heard.filter((e) => e.type === "edge_created")).toHaveLength(1);
  });

  it("a purge announces every edge it cascades, in both directions", async () => {
    const doomed = await note("purge-doomed");
    const other = await note("purge-other");
    // One edge out of the doomed item and one pointing at it. The inbound
    // one is the case that cannot be inferred: it lives on `other`, which
    // is not being purged and gets no item event at all.
    const outboundRes = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: { source_id: doomed, target_id: other, edge_type: "references" },
    });
    const inboundRes = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: { source_id: other, target_id: doomed, edge_type: "references" },
    });
    const outbound = ((await outboundRes.json()) as { edge: { id: string } })
      .edge.id;
    const inbound = ((await inboundRes.json()) as { edge: { id: string } }).edge
      .id;

    await request(ctx.app, "DELETE", `/items/${doomed}`, { key: ctx.adminKey });
    // Both awaited by id. A count of two passes on any two deletions,
    // including a pair from a sibling test sharing this emitter.
    const outboundHeard = nextEdgeEvent(
      (e) => e.type === "edge_deleted" && e.edge.id === outbound,
    );
    const inboundHeard = nextEdgeEvent(
      (e) => e.type === "edge_deleted" && e.edge.id === inbound,
    );
    const res = await request(ctx.app, "DELETE", `/items/${doomed}/purge`, {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    await outboundHeard;
    await inboundHeard;
  });

  it("a bulk purge announces its cascade, and emits edges only", async () => {
    // The cascade is announced whether or not the caller asked for
    // fan-out: publishing is what appends the event log row, so a silent
    // cascade left a client that was offline unable to learn the edge was
    // gone. `enable_fanout` decides what happens downstream of that row.
    //
    // **No item event, deliberately.** There is no purge event in the
    // contract, the trash transition that precedes a purge already
    // announced the item, and the single-item purge door emits none —
    // so publishing one here would make a bulk purge noisier than the
    // door it mirrors.
    async function purgeOne(emit: boolean): Promise<{
      items: string[];
      edges: string[];
    }> {
      const tag = `bulkpurge-${Math.random().toString(36).slice(2, 8)}`;
      const seed = await request(ctx.app, "POST", "/items", {
        key: ctx.adminKey,
        body: {
          type: "core.note",
          properties: { body: "bulk-purge-doomed" },
          tags: [tag],
        },
      });
      expect(seed.status).toBe(201);
      const doomed = ((await seed.json()) as { item: { id: string } }).item.id;
      const other = await note(`bulk-purge-other-${tag}`);
      // Inbound only: it lives on `other`, which is not being purged, so
      // nothing but the edge event tells that item's holder it changed.
      await request(ctx.app, "POST", "/edges", {
        key: ctx.adminKey,
        body: { source_id: other, target_id: doomed, edge_type: "references" },
      });

      const itemController = new AbortController();
      const edgeController = new AbortController();
      const itemWatcher = collectItemEvents(itemController.signal);
      const edgeWatcher = collectEdgeEvents(edgeController.signal);
      await settle();

      const run = await runBulkActionAsync(
        ctx,
        {
          action: "purge",
          confirm: "PURGE",
          filter: { tags: [tag] },
          ...(emit ? { enable_fanout: true } : {}),
        },
        ctx.adminKey,
      );
      expect(run.initialStatus).toBe(202);
      expect(run.result?.succeeded).toBe(1);

      await settle();
      itemController.abort();
      edgeController.abort();
      await itemWatcher.done;
      await edgeWatcher.done;
      return {
        items: itemWatcher.events
          .filter((e) => e.item.id === doomed)
          .map((e) => e.type),
        edges: edgeWatcher.events
          .filter((e) => e.type === "edge_deleted")
          .map((e) => e.edge.id),
      };
    }

    const loud = await purgeOne(true);
    expect(loud.edges).toHaveLength(1);
    // The item is not announced on either door.
    expect(loud.items).toHaveLength(0);

    const quiet = await purgeOne(false);
    // Same events either way: an edge nobody can see disappear is one a
    // durable client keeps forever. The flag governs the outbound work
    // downstream of these events, which the bus cannot observe.
    expect(quiet.edges).toHaveLength(1);
    expect(quiet.items).toHaveLength(0);
  });

  it("a bulk transition announces the state it moved items to", async () => {
    const tag = `bulkmove-${Math.random().toString(36).slice(2, 8)}`;
    const seed = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "bulk-transition" },
        tags: [tag],
      },
    });
    expect(seed.status).toBe(201);
    const moved = ((await seed.json()) as { item: { id: string } }).item.id;

    const controller = new AbortController();
    const watcher = collectItemEvents(controller.signal);
    await settle();
    const run = await runBulkActionAsync(
      ctx,
      {
        action: "transition",
        state: "archived",
        filter: { tags: [tag] },
        enable_fanout: true,
      },
      ctx.adminKey,
    );
    expect(run.initialStatus).toBe(202);
    await settle();
    controller.abort();
    await watcher.done;

    const seen = watcher.events.filter((e) => e.item.id === moved);
    expect(seen.map((e) => e.type)).toContain("state_changed");
    expect(seen[0]?.item.state).toBe("archived");
  });

  it("a bulk transition announces the move with no flag set", async () => {
    // The other direction. This asserted silence, which is what let a
    // whole bulk action write rows no client replaying the stream could
    // ever see: publishing is what appends the event log row.
    const tag = `bulkquiet-${Math.random().toString(36).slice(2, 8)}`;
    const seed = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "bulk-transition-quiet" },
        tags: [tag],
      },
    });
    expect(seed.status).toBe(201);
    const moved = ((await seed.json()) as { item: { id: string } }).item.id;

    const controller = new AbortController();
    const watcher = collectItemEvents(controller.signal);
    await settle();
    const run = await runBulkActionAsync(
      ctx,
      { action: "transition", state: "archived", filter: { tags: [tag] } },
      ctx.adminKey,
    );
    expect(run.initialStatus).toBe(202);
    expect(run.result?.succeeded).toBe(1);
    await settle();
    controller.abort();
    await watcher.done;

    const heard = watcher.events.filter((e) => e.item.id === moved);
    expect(heard.map((e) => e.type)).toEqual(["state_changed"]);
    expect(heard[0]?.item.state).toBe("archived");
  });

  it("POST /items/bulk announces an inline edge with or without fan-out", async () => {
    const target = await note("bulk-inline-target");
    const quiet = await edgeEventsDuring(async () => {
      const res = await request(ctx.app, "POST", "/items/bulk", {
        key: ctx.adminKey,
        body: {
          items: [
            {
              type: "core.note",
              properties: { body: "quiet" },
              source_id: `quiet-${String(Math.random())}`,
              edges: { references: [target] },
            },
          ],
        },
      });
      expect(res.status).toBe(200);
    });
    // An inline edge follows the item it was written with rather than
    // inventing a second answer, and that item is always announced now.
    expect(quiet.filter((e) => e.type === "edge_created")).toHaveLength(1);

    const loud = await edgeEventsDuring(async () => {
      const res = await request(ctx.app, "POST", "/items/bulk", {
        key: ctx.adminKey,
        body: {
          enable_fanout: true,
          items: [
            {
              type: "core.note",
              properties: { body: "loud" },
              source_id: `loud-${String(Math.random())}`,
              edges: { references: [target] },
            },
          ],
        },
      });
      expect(res.status).toBe(200);
    });
    expect(loud.filter((e) => e.type === "edge_created")).toHaveLength(1);
  });
});

describe("the remaining doors that write an edge", () => {
  it("a promotion announces the join back to the mirror", async () => {
    // The `derived-from` edge is the whole point of a promotion: a device
    // told about the new item and not about the edge holds an item that
    // appears to have come from nowhere.
    const mirror = await ctx.storage.items.create(
      {
        type: "core.note",
        properties: { body: "an upstream record" },
        source: "integration:acme.promotefixture",
        source_id: `mirror-${Math.random().toString(36).slice(2, 8)}`,
      },
      undefined,
    );

    let promotedId = "";
    const heard = await edgeEventsDuring(async () => {
      const res = await request(
        ctx.app,
        "POST",
        `/items/${mirror.id}/promote`,
        { key: ctx.adminKey },
      );
      expect(res.status).toBe(201);
      promotedId = ((await res.json()) as { item: { id: string } }).item.id;
    });

    const created = heard.filter((e) => e.type === "edge_created");
    expect(created).toHaveLength(1);
    // And it is the edge joining the two, not some other write.
    const listed = await request(ctx.app, "GET", `/items/${promotedId}/edges`, {
      key: ctx.adminKey,
    });
    const rows = (await listed.json()) as {
      data: { id: string; edge_type: string; target_id: string }[];
    };
    expect(rows.data[0]?.edge_type).toBe("derived-from");
    expect(rows.data[0]?.target_id).toBe(mirror.id);
    expect(created[0]?.edge.id).toBe(rows.data[0]?.id);
  });

  it("a natural-key re-sync announces the edges it replaces", async () => {
    // The upsert short-circuit reaches `applyInlineEdges`, the same helper
    // the bulk and patch doors use — so its silence was one silence in
    // three places.
    const sourceKey = `resync-${Math.random().toString(36).slice(2, 8)}`;
    const first = await note("resync-target-1");
    const second = await note("resync-target-2");

    const seeded = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        source_id: sourceKey,
        properties: { body: "resync-source" },
        edges: { references: [first] },
      },
    });
    expect(seeded.status).toBe(201);
    const sourceItem = ((await seeded.json()) as { item: { id: string } }).item
      .id;
    const before = await request(ctx.app, "GET", `/items/${sourceItem}/edges`, {
      key: ctx.adminKey,
    });
    const oldId = ((await before.json()) as { data: { id: string }[] }).data[0]
      ?.id;

    const heard = await edgeEventsDuring(async () => {
      // Same natural key, so this resolves the existing row rather than
      // creating one — and its edges are replaced in place.
      const res = await request(ctx.app, "POST", "/items", {
        key: ctx.adminKey,
        body: {
          type: "core.note",
          source_id: sourceKey,
          properties: { body: "resync-source" },
          edges: { references: [second] },
        },
      });
      expect(res.status).toBe(200);
    });

    expect(
      heard.some((e) => e.type === "edge_deleted" && e.edge.id === oldId),
    ).toBe(true);
    expect(heard.filter((e) => e.type === "edge_created")).toHaveLength(1);
  });
});

describe("the two doors this suite would otherwise leave uncovered", () => {
  it("DELETE /edges/{id} announces the edge it removed", async () => {
    // The one pre-existing door with no test of its own. It published
    // before this change and still does, which is exactly why it needs
    // one: nothing else here would notice if the collapse onto the
    // shared helper had taken its publish with it.
    const source = await note("delete-door-source");
    const target = await note("delete-door-target");
    const created = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: { source_id: source, target_id: target, edge_type: "references" },
    });
    expect(created.status).toBe(201);
    const edgeId = ((await created.json()) as { edge: { id: string } }).edge.id;

    const announced = nextEdgeEvent(
      (e) => e.type === "edge_deleted" && e.edge.id === edgeId,
    );
    const res = await request(ctx.app, "DELETE", `/edges/${edgeId}`, {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);

    const event = await announced;
    expect(event.edge.source_id).toBe(source);
    expect(event.edge.target_id).toBe(target);
    expect(event.edge.edge_type).toBe("references");
  });

  it("sign-up starter content announces the edge it seeds", async () => {
    // Provisioning writes one `references` edge through the same shared
    // helper. A space being provisioned has no subscribers of its own, so
    // this is the one door whose silence nobody would ever report — which
    // is why it gets a test rather than an assumption.
    const spaces = ctx.storage.spaces;
    if (!spaces) throw new Error("this test needs a space store");
    const space = await spaces.create(
      `starter-${Math.random().toString(36).slice(2, 8)}`,
    );

    const announced = nextEdgeEvent(
      (e) => e.type === "edge_created" && e.edge.space_id === space.id,
    );
    await seedStarterContent(ctx.storage, space.id);

    const event = await announced;
    expect(event.edge.edge_type).toBe("references");
  });
});

describe("an announcement never outlives the write it describes", () => {
  it("an atomic bulk batch that rolls back announces no edge", async () => {
    // `applyInlineEdges` runs inside the caller's transaction, so
    // publishing from there described a graph that could still be undone:
    // an atomic batch — the default — writes item 1's edges, fails on
    // item 2, and rolls the lot back, leaving subscribers an
    // `edge.created` with no row behind it and nothing to correct it.
    const target = await note("rollback-target");
    const heard = await edgeEventsDuring(async () => {
      const res = await request(ctx.app, "POST", "/items/bulk", {
        key: ctx.adminKey,
        body: {
          enable_fanout: true,
          items: [
            {
              type: "core.note",
              properties: { body: "lands first" },
              source_id: `rollback-a-${String(Math.random())}`,
              edges: { references: [target] },
            },
            {
              // Fails during its own processing rather than in the
              // atomic pre-pass, which is the whole point: a pre-pass
              // failure aborts before item 1 writes anything, so it
              // could not catch a publish that happens mid-batch. A
              // well-formed id that names no row passes the shape check
              // and is refused by the edge-constraint pass instead.
              type: "core.note",
              properties: { body: "fails second" },
              source_id: `rollback-b-${String(Math.random())}`,
              edges: { references: [generateId()] },
            },
          ],
        },
      });
      // The batch is refused as a whole.
      expect(res.status).toBe(400);
    });

    expect(
      heard.filter(
        (e) => e.type === "edge_created" && e.edge.target_id === target,
      ),
    ).toHaveLength(0);

    // And the edge really is absent, so the assertion above is about a
    // rollback rather than about an event that merely arrived late.
    const listed = await request(ctx.app, "GET", `/items/${target}/backrefs`, {
      key: ctx.adminKey,
    });
    expect(((await listed.json()) as { data: unknown[] }).data).toHaveLength(0);
  });
});

describe("the properties the announcement itself has to hold", () => {
  it("announces deletions before creations within one replacement", async () => {
    // A subscriber replaying a replacement in order must never briefly
    // hold both the old edge and the new one. The body states this as a
    // contract line, so it gets an assertion rather than a comment.
    const source = await note("order-source");
    const first = await note("order-target-1");
    const second = await note("order-target-2");
    await request(ctx.app, "PATCH", `/items/${source}`, {
      key: ctx.adminKey,
      body: { edges: { references: [first] } },
    });

    const heard = await edgeEventsDuring(async () => {
      const res = await request(ctx.app, "PATCH", `/items/${source}`, {
        key: ctx.adminKey,
        body: { edges: { references: [second] } },
      });
      expect(res.status).toBe(200);
    });

    const mine = heard.filter(
      (e) => e.edge.source_id === source || e.edge.target_id === source,
    );
    const deletedAt = mine.findIndex((e) => e.type === "edge_deleted");
    const createdAt = mine.findIndex((e) => e.type === "edge_created");
    expect(deletedAt).toBeGreaterThanOrEqual(0);
    expect(createdAt).toBeGreaterThanOrEqual(0);
    expect(deletedAt).toBeLessThan(createdAt);
  });

  it("a purge chunk that errored announces nothing", async () => {
    // `cascaded` is filled by the first batch delete, before the
    // statements after it can throw. Without the guard the chunk reports
    // every id as errored and still announces the edges it staged —
    // deletions for rows a rollback put back.
    const tag = `errored-${Math.random().toString(36).slice(2, 8)}`;
    const seed = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "doomed" }, tags: [tag] },
    });
    expect(seed.status).toBe(201);
    const doomed = ((await seed.json()) as { item: { id: string } }).item.id;
    const other = await note(`errored-other-${tag}`);
    // **Outbound**, so the first batch delete actually stages it. An
    // inbound-only fixture leaves `cascaded` empty and the test passes
    // whether or not the guard exists — which is what it did until a
    // mutation showed the guard could be removed with the test green.
    const edgeRes = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: { source_id: doomed, target_id: other, edge_type: "references" },
    });
    const edgeId = ((await edgeRes.json()) as { edge: { id: string } }).edge.id;

    const store = ctx.storage.edges;
    const realByTarget = store.deleteByTargetBatch.bind(store);
    store.deleteByTargetBatch = () =>
      Promise.reject(new Error("simulated storage failure"));

    const heard = await edgeEventsDuring(async () => {
      await runBulkActionAsync(
        ctx,
        {
          action: "purge",
          confirm: "PURGE",
          filter: { tags: [tag] },
          enable_fanout: true,
        },
        ctx.adminKey,
      );
    });
    store.deleteByTargetBatch = realByTarget;

    // The first delete staged this edge before the second threw. Nothing
    // about a failed chunk may reach a subscriber.
    expect(
      heard.filter((e) => e.type === "edge_deleted" && e.edge.id === edgeId),
    ).toHaveLength(0);
  });

  it("the batch deletes stop at the space they are given", async () => {
    // The batch deletes take a space id now, and this pins the parameter
    // rather than the route: `POST /items/bulk-actions` purge is
    // `requireAdmin`, which refuses a space-bound key, so every purge
    // through that door runs unscoped and cannot reach the fence. Tested
    // at the store because that is where it is reachable — and where the
    // next caller of these methods will meet it.
    const spaces = ctx.storage.spaces;
    if (!spaces) throw new Error("this test needs a space store");
    const mine = await spaces.create(
      `fence-mine-${Math.random().toString(36).slice(2, 8)}`,
    );
    const theirs = await spaces.create(
      `fence-theirs-${Math.random().toString(36).slice(2, 8)}`,
    );

    const shared = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "target" } },
      mine.id,
    );
    const mySource = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "my source" } },
      mine.id,
    );
    const theirSource = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "their source" } },
      theirs.id,
    );

    const myEdge = await ctx.storage.edges.createRaw(
      {
        source_id: mySource.id,
        target_id: shared.id,
        edge_type: "references",
      },
      mine.id,
    );
    // Reachable by the same target id, and belonging to another space.
    const theirEdge = await ctx.storage.edges.createRaw(
      {
        source_id: theirSource.id,
        target_id: shared.id,
        edge_type: "references",
      },
      theirs.id,
    );

    const removed = await ctx.storage.edges.deleteByTargetBatch(
      [shared.id],
      undefined,
      mine.id,
    );
    expect(removed.map((e) => e.id)).toEqual([myEdge.id]);
    // Still there, and not reported as removed — a fence that only
    // narrowed the return value would leave the row deleted and the
    // subscriber merely uninformed.
    expect(await ctx.storage.edges.get(theirEdge.id)).not.toBeNull();
  });
});
