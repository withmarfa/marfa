import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { TEST_OWNER } from "../../utils/target.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import type { SseEvent } from "../../utils/sse.js";
import { collectUntil, withStream } from "../../utils/stream.js";
import {
  DAY_MS,
  movedClock,
  operatorOf,
  quiet,
  runJob,
  writerOf,
} from "../../utils/moved-clock.js";

/**
 * How the `feed-expiry` job moves feed items to the bin by their type's
 * `retention_policy`.
 *
 * Nothing a request does ages an item, so each case writes through the doors,
 * moves the server's clock and runs the job. A case that asserts an item was
 * kept has a witness beside it in the same case: an item of the same kind
 * that the job does move, or the same item moved once the one condition that
 * keeps it is removed. The clock only moves forward, so the cases share one
 * server, each registers types of its own, and each reads only its own items.
 */

afterAll(stopFreshServers, 2 * FRESH_SERVER_TIMEOUT_MS);

let server: FreshServer;
let writer: MarfaClient;
let operator: MarfaClient;
let clock: ReturnType<typeof movedClock>;
let sequence = 0;

beforeAll(async () => {
  server = await bootFreshServer("housekeeping-feed-expiry", {
    // Past reach, so only the runs a case asks for happen.
    FEED_EXPIRY_INTERVAL_MS: "3153600000000",
    MARFA_EVENT_LOG_CLEANUP_INTERVAL_MS: "3153600000000",
  });
  writer = writerOf(server);
  operator = operatorOf(server);
  clock = movedClock(server);
  await quiet(server, ["feed-expiry", "event-log-cleanup"]);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

type Registration = Parameters<MarfaClient["registerType"]>[0];

async function register(
  retention_policy?: object | null,
  parent?: string,
): Promise<string> {
  sequence += 1;
  const id = `user.feed-expiry-${String(Date.now())}-${String(sequence)}`;
  const registered = await writer.registerType({
    id,
    fields: parent === undefined ? { title: { type: "string" } } : {},
    ...(parent !== undefined && { parent }),
    ...(retention_policy !== undefined && { retention_policy }),
  } as Registration);
  expect(registered.status, JSON.stringify(registered.error)).toBe(201);
  return id;
}

async function add(
  type: string,
  extra: { tier?: "library" | "feed"; source_id?: string } = {},
): Promise<string> {
  const created = await writer.createItem({
    type,
    tier: "feed",
    properties: { title: `item ${String(++sequence)}` },
    ...extra,
  } as Parameters<MarfaClient["createItem"]>[0]);
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  return created.data.item.id;
}

/** The state of each item of `type`, the bin and the archive included. */
async function statesOf(type: string): Promise<Record<string, string>> {
  const states: Record<string, string> = {};
  let cursor: string | undefined;
  do {
    const page = await writer.listItems({
      type,
      state: "any",
      tier: "all",
      limit: 100,
      ...(cursor !== undefined && { cursor }),
    });
    expect(page.status, JSON.stringify(page.error)).toBe(200);
    for (const item of page.data.data) states[item.id] = item.state;
    cursor = page.data.next_cursor ?? undefined;
  } while (cursor !== undefined);
  return states;
}

async function stateOf(type: string, id: string): Promise<string | undefined> {
  return (await statesOf(type))[id];
}

async function expire(): Promise<{ moved: number; held: number }> {
  const run = await runJob(server, "feed-expiry");
  expect(run.outcome, String(run.error)).toBe("ok");
  return run.result as { moved: number; held: number };
}

/** A minute short of `days`, and the two minutes that carry it past. */
async function justBefore(days: number): Promise<void> {
  await clock.advance(days * DAY_MS - 60_000);
}
async function justAfter(): Promise<void> {
  await clock.advance(120_000);
}

describe("the feed-expiry job", () => {
  it("reports the number of items it moved to the bin and the number it held back", async () => {
    // First, so that only this case's types have a window to act on.
    const type = await register({ feed_days: 2 });
    const ids = [await add(type), await add(type), await add(type)];

    await clock.advance(3 * DAY_MS);
    const result = await expire();
    expect(result.moved).toBe(3);
    expect(result.held).toBe(0);
    const states = await statesOf(type);
    for (const id of ids) expect(states[id]).toBe("trashed");

    const listed = (await operator.listHousekeeping()).data.data.find(
      (row) => row.name === "feed-expiry",
    );
    expect(listed?.last_outcome).toBe("ok");
    expect(listed?.last_result).toMatchObject({ moved: 3, held: 0 });

    // The witness: with nothing left to move, the same run reports none.
    expect((await expire()).moved).toBe(0);
  });

  it("moves a feed item to the bin once its type's days have passed since it arrived, and not before", async () => {
    const type = await register({ feed_days: 10 });
    const id = await add(type);

    await justBefore(10);
    await expire();
    expect(await stateOf(type, id)).toBe("active");

    await justAfter();
    await expire();
    expect(await stateOf(type, id)).toBe("trashed");
  });

  it("counts from arrival, which a natural-key upsert keeps", async () => {
    const type = await register({ feed_days: 10 });
    const id = await add(type, { source_id: "arrival/entry-1" });

    await clock.advance(8 * DAY_MS);
    const again = await writer.createItem({
      type,
      tier: "feed",
      source_id: "arrival/entry-1",
      properties: { title: "refreshed" },
    } as Parameters<MarfaClient["createItem"]>[0]);
    expect(again.status, JSON.stringify(again.error)).toBeLessThan(300);
    expect(again.data.item.id).toBe(id);
    expect(again.data.item.properties.title).toBe("refreshed");
    expect(again.data.item.created_at).toBe(
      (await writer.getItem(id)).data.item.created_at,
    );

    await clock.advance(3 * DAY_MS);
    await expire();
    expect(await stateOf(type, id)).toBe("trashed");
  });

  it("judges an item moved from the library to the feed by its arrival, at the next run", async () => {
    const type = await register({ feed_days: 10 });
    const id = await add(type, { tier: "library" });

    await clock.advance(100 * DAY_MS);
    await expire();
    expect(await stateOf(type, id)).toBe("active");

    const moved = await writer.updateItem(id, { tier: "feed", version: 1 });
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);
    await expire();
    expect(await stateOf(type, id)).toBe("trashed");
    // Recoverable, as any item in the bin is.
    expect((await writer.restoreItem(id)).status).toBe(200);
  });

  it("keeps a library item past the window, and the feed item beside it goes", async () => {
    const type = await register({ feed_days: 2 });
    const library = await add(type, { tier: "library" });
    const feed = await add(type);

    await clock.advance(5 * DAY_MS);
    await expire();
    const states = await statesOf(type);
    expect(states[feed]).toBe("trashed");
    expect(states[library]).toBe("active");
  });

  it("keeps the items of a type whose window is absent or null, and a child's own window applies", async () => {
    const bare = await register();
    const expiring = await register({ feed_days: 5 });
    const keeping = await register({ feed_days: null }, expiring);
    const below = await register(undefined, keeping);
    const own = await register({ feed_days: 3 }, keeping);
    const kept = [
      [bare, await add(bare)],
      [keeping, await add(keeping)],
      [below, await add(below)],
    ] as const;
    // The witnesses: the parent expires, and a child naming a window under
    // the one that keeps goes by that window.
    const goes = [
      [expiring, await add(expiring)],
      [own, await add(own)],
    ] as const;

    await clock.advance(10 * DAY_MS);
    await expire();
    for (const [type, id] of kept)
      expect(await stateOf(type, id)).toBe("active");
    for (const [type, id] of goes) {
      expect(await stateOf(type, id)).toBe("trashed");
    }
  });

  it("takes a child's window from its parent, and a grandchild's from the chain", async () => {
    const parent = await register({ feed_days: 10 });
    const child = await register(undefined, parent);
    const grandchild = await register(undefined, child);
    const sooner = await register({ feed_days: 2 }, child);
    const ids = {
      parent: await add(parent),
      child: await add(child),
      grandchild: await add(grandchild),
      sooner: await add(sooner),
    };

    await clock.advance(5 * DAY_MS);
    await expire();
    expect(await stateOf(sooner, ids.sooner)).toBe("trashed");
    expect(await stateOf(parent, ids.parent)).toBe("active");
    expect(await stateOf(child, ids.child)).toBe("active");
    expect(await stateOf(grandchild, ids.grandchild)).toBe("active");

    await clock.advance(6 * DAY_MS);
    await expire();
    expect(await stateOf(parent, ids.parent)).toBe("trashed");
    expect(await stateOf(child, ids.child)).toBe("trashed");
    expect(await stateOf(grandchild, ids.grandchild)).toBe("trashed");
  });

  it("applies the window a type has at the next run when it is changed after the items arrived", async () => {
    const type = await register({ feed_days: 30 });
    const id = await add(type);

    await clock.advance(5 * DAY_MS);
    await expire();
    expect(await stateOf(type, id)).toBe("active");

    const current = await writer.getType(type);
    const replaced = await writer.replaceType(type, {
      ...current.data,
      retention_policy: { feed_days: 1 },
    });
    expect(replaced.status, JSON.stringify(replaced.error)).toBe(200);
    await expire();
    expect(await stateOf(type, id)).toBe("trashed");
  });

  it("keeps a feed item a person archived, and the active one beside it goes", async () => {
    const type = await register({ feed_days: 2 });
    const archived = await add(type);
    const active = await add(type);
    expect((await writer.transitionItem(archived, "archived")).status).toBe(
      200,
    );

    await clock.advance(5 * DAY_MS);
    await expire();
    const states = await statesOf(type);
    expect(states[archived]).toBe("archived");
    expect(states[active]).toBe("trashed");
  });

  it("leaves an item already in the bin where it is, with no second announcement", async () => {
    const type = await register({ feed_days: 2 });
    const binned = await add(type);
    const live = await add(type);
    expect((await writer.deleteItem(binned)).status).toBe(200);
    const cursor = await cursorNow();

    await clock.advance(5 * DAY_MS);
    await expire();
    const states = await statesOf(type);
    expect(states[binned]).toBe("trashed");
    expect(states[live]).toBe("trashed");

    // The live item's announcement closes the read, so the absence of the
    // binned one's is settled by a later frame and not by a quiet window.
    const events = await readFrom(cursor, (seen) =>
      seen.some((e) => e.event === "item.deleted" && itemOf(e) === live),
    );
    expect(events.filter((e) => itemOf(e) === binned)).toEqual([]);
  });

  it("does not move an item again that was brought back from the bin, by restore or by transition", async () => {
    const type = await register({ feed_days: 2 });
    const viaRestore = await add(type);
    const viaTransition = await add(type);

    await clock.advance(5 * DAY_MS);
    await expire();
    const first = await statesOf(type);
    expect(first[viaRestore]).toBe("trashed");
    expect(first[viaTransition]).toBe("trashed");

    expect((await writer.restoreItem(viaRestore)).status).toBe(200);
    expect((await writer.transitionItem(viaTransition, "active")).status).toBe(
      200,
    );

    await clock.advance(10 * DAY_MS);
    await expire();
    const second = await statesOf(type);
    expect(second[viaRestore]).toBe("active");
    expect(second[viaTransition]).toBe("active");

    // The witness: a fresh item of the type is moved by the same run.
    const fresh = await add(type);
    await clock.advance(5 * DAY_MS);
    await expire();
    expect(await stateOf(type, fresh)).toBe("trashed");
    expect((await statesOf(type))[viaRestore]).toBe("active");
  });

  it("keeps an item brought back from the bin through an archive restored into a new instance", async () => {
    const type = await register({ feed_days: 2 });
    const restored = await add(type);

    await clock.advance(5 * DAY_MS);
    await expire();
    expect(await stateOf(type, restored)).toBe("trashed");
    expect((await writer.restoreItem(restored)).status).toBe(200);
    // The witness arrives after the run, so it was never in the bin.
    const never = await add(type);

    const archive = await writer.exportArchive({ type });
    expect(archive.status, JSON.stringify(archive.error)).toBe(200);

    const target = await bootFreshServer("housekeeping-feed-expiry-restore", {
      FEED_EXPIRY_INTERVAL_MS: "3153600000000",
    });
    const owner = new MarfaClient({
      baseUrl: target.apiUrl,
      apiKey: "",
      ownerCookie: target.ownerCookie,
      ownerCredentials: TEST_OWNER,
    });
    const imported = await owner.restoreArchive(archive.data);
    expect(imported.ok, JSON.stringify(imported.error)).toBe(true);
    expect(imported.data.imported).toBe(2);
    await quiet(target, ["feed-expiry"]);

    // The target's clock is behind the source's; carry it a window past both.
    await target.advanceClock(clock.now() - Date.now() + 5 * DAY_MS);
    const run = await runJob(target, "feed-expiry");
    expect(run.outcome, String(run.error)).toBe("ok");
    const read = (id: string) => writerOf(target).getItem(id);
    expect((await read(restored)).data.item.state).toBe("active");
    expect((await read(never)).status).toBe(404);
  });

  it("keeps the items of a type that was force-deleted, and judges them once it is registered again", async () => {
    const type = await register({ feed_days: 2 });
    const id = await add(type);
    const removed = await writer.deleteType(type, true);
    expect(removed.status, JSON.stringify(removed.error)).toBe(200);

    await clock.advance(5 * DAY_MS);
    await expire();
    // The type is gone, so the item is read by its id.
    const kept = await writer.getItem(id);
    expect(kept.status, JSON.stringify(kept.error)).toBe(200);
    expect(kept.data.item.state).toBe("active");

    const again = await writer.registerType({
      id: type,
      fields: { title: { type: "string" } },
      retention_policy: { feed_days: 2 },
    } as Registration);
    expect(again.status, JSON.stringify(again.error)).toBe(201);
    await expire();
    expect(await stateOf(type, id)).toBe("trashed");
  });

  it("moves every expired item however many there are", async () => {
    const type = await register({ feed_days: 1 });
    const created = await writer.bulkItems({
      items: Array.from({ length: 250 }, (_, n) => ({
        type,
        tier: "feed" as const,
        properties: { title: `bulk ${String(n)}` },
      })),
    });
    expect(created.status, JSON.stringify(created.error)).toBeLessThan(300);

    await clock.advance(3 * DAY_MS);
    const result = await expire();
    expect(result.moved).toBeGreaterThanOrEqual(250);
    const states = Object.values(await statesOf(type));
    expect(states).toHaveLength(250);
    expect(states.every((state) => state === "trashed")).toBe(true);
  });
});

describe("what the move to the bin is", () => {
  async function expiredOne(): Promise<{
    type: string;
    id: string;
    cursor: string;
  }> {
    const type = await register({ feed_days: 1 });
    const id = await add(type);
    const cursor = await cursorNow();
    await clock.advance(3 * DAY_MS);
    await expire();
    expect(await stateOf(type, id)).toBe("trashed");
    return { type, id, cursor };
  }

  it("keeps an expired item in the bin, where a restore brings it back active", async () => {
    const { type, id } = await expiredOne();
    const restored = await writer.restoreItem(id);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data.item.state).toBe("active");
    expect(await stateOf(type, id)).toBe("active");
  });

  it("announces item.deleted for an expired item", async () => {
    const { id, cursor } = await expiredOne();
    const events = await readFrom(cursor, (seen) =>
      seen.some((e) => e.event === "item.deleted" && itemOf(e) === id),
    );
    const frames = events.filter(
      (e) => e.event === "item.deleted" && itemOf(e) === id,
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]!.id).toBeDefined();
  });

  it("records an audit entry naming the type and the items it moved", async () => {
    const { type, id } = await expiredOne();
    const audit = await operator.listAudit({ action: "items.feed_expired" });
    expect(audit.status, JSON.stringify(audit.error)).toBe(200);
    const entry = audit.data.data.find(
      (row) =>
        row.details.type === type &&
        Array.isArray(row.details.item_ids) &&
        row.details.item_ids.includes(id),
    );
    expect(entry).toBeDefined();
    expect(entry!.details.moved).toBe(1);
  });

  it("leaves the library copy a feed item was promoted to active and unchanged", async () => {
    const type = await register({ feed_days: 1 });
    const feed = await add(type);
    const copy = await writer.createItem({
      type: "core.note",
      tier: "library",
      properties: { body: "a copy a person made" },
    } as Parameters<MarfaClient["createItem"]>[0]);
    expect(copy.status, JSON.stringify(copy.error)).toBe(201);
    const edge = await writer.createEdge({
      source_id: copy.data.item.id,
      target_id: feed,
      edge_type: "derived-from",
    });
    expect(edge.status, JSON.stringify(edge.error)).toBe(201);
    const before = (await writer.getItem(copy.data.item.id)).data.item;

    await clock.advance(3 * DAY_MS);
    await expire();
    expect(await stateOf(type, feed)).toBe("trashed");
    const after = (await writer.getItem(copy.data.item.id)).data.item;
    expect(after).toEqual(before);
    expect(after.state).toBe("active");
    expect(after.tier).toBe("library");
  });
});

describe("what the move to the bin takes with it", () => {
  async function parentOf(
    type: string,
    parent: string,
    child: string,
  ): Promise<void> {
    const edge = await writer.createEdge({
      source_id: parent,
      target_id: child,
      edge_type: "parent-of",
    });
    expect(edge.status, JSON.stringify(edge.error)).toBe(201);
    expect(type).toBeDefined();
  }

  it("takes a parent with its children when all of them are expired feed items", async () => {
    const type = await register({ feed_days: 3 });
    const parent = await add(type);
    const child = await add(type);
    await parentOf(type, parent, child);

    await clock.advance(5 * DAY_MS);
    // Both are counted, the child the parent's cascade took as well.
    expect((await expire()).moved).toBe(2);
    const states = await statesOf(type);
    expect(states[parent]).toBe("trashed");
    expect(states[child]).toBe("trashed");
  });

  it("holds back a parent whose children include an item that has not expired or is in the library", async () => {
    const type = await register({ feed_days: 10 });
    const parent = await add(type);
    const old = await add(type);
    await parentOf(type, parent, old);

    await clock.advance(6 * DAY_MS);
    const young = await add(type);
    const library = await add(type, { tier: "library" });
    await parentOf(type, parent, young);
    await parentOf(type, parent, library);

    await clock.advance(5 * DAY_MS);
    const first = await expire();
    expect(first.held).toBeGreaterThanOrEqual(1);
    let states = await statesOf(type);
    expect(states[old]).toBe("trashed");
    expect(states[parent]).toBe("active");
    expect(states[young]).toBe("active");
    expect(states[library]).toBe("active");

    // The witness: the young child comes of age, and the library item is the
    // one thing left that holds the parent.
    await clock.advance(6 * DAY_MS);
    await expire();
    states = await statesOf(type);
    expect(states[young]).toBe("trashed");
    expect(states[parent]).toBe("active");
    expect(states[library]).toBe("active");
  });

  it("holds back an item whose delete an edge with cascade_on_delete block refuses", async () => {
    const type = await register({ feed_days: 1 });
    const edgeType = `user.feed-expiry-block-${String(Date.now())}-${String(++sequence)}`;
    const registered = await writer.registerEdgeType({
      id: edgeType,
      cardinality: "many-to-many",
      source_type_constraints: ["*"],
      target_type_constraints: ["*"],
      cascade_on_delete: "block",
    } as Parameters<MarfaClient["registerEdgeType"]>[0]);
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    const held = await add(type);
    const free = await add(type);
    const other = await writer.createItem({
      type: "core.note",
      tier: "library",
      properties: { body: "refuses the delete" },
    } as Parameters<MarfaClient["createItem"]>[0]);
    const edge = await writer.createEdge({
      source_id: other.data.item.id,
      target_id: held,
      edge_type: edgeType,
    });
    expect(edge.status, JSON.stringify(edge.error)).toBe(201);

    await clock.advance(3 * DAY_MS);
    const result = await expire();
    expect(result.held).toBeGreaterThanOrEqual(1);
    const states = await statesOf(type);
    expect(states[held]).toBe("active");
    expect(states[free]).toBe("trashed");
  });
});

describe("the event log's retention", () => {
  it("is the event log's own, whatever window a type names", async () => {
    // A window of a day is far inside the event log's default of seven.
    const type = await register({ feed_days: 1 });
    const cursor = await cursorNow();
    const id = await add(type);
    await clock.advance(3 * DAY_MS);
    await expire();
    expect(await stateOf(type, id)).toBe("trashed");

    const cleanup = await runJob(server, "event-log-cleanup");
    expect(cleanup.outcome, String(cleanup.error)).toBe("ok");
    // The item's creation, three days old, is still in the log.
    const events = await readFrom(cursor, (seen) =>
      seen.some((e) => e.event === "item.deleted" && itemOf(e) === id),
    );
    expect(events.some((e) => e.event === "catchup_too_old")).toBe(false);
    expect(
      events.some((e) => e.event === "item.created" && itemOf(e) === id),
    ).toBe(true);

    // The witness: the log's own window passes, and its cleanup then removes
    // the same events, so the same cursor is too old.
    await clock.advance(10 * DAY_MS);
    const later = await runJob(server, "event-log-cleanup");
    expect(later.outcome, String(later.error)).toBe("ok");
    expect((later.result as { deleted: number }).deleted).toBeGreaterThan(0);
    const refused = await readFrom(cursor, (seen) =>
      seen.some((e) => e.event === "catchup_too_old"),
    );
    expect(refused.some((e) => e.event === "catchup_too_old")).toBe(true);
  });
});

const itemOf = (e: SseEvent): string | undefined =>
  (e.data as { item?: { id?: string } }).item?.id;

/** The id of the newest event, established by writing one. */
async function cursorNow(): Promise<string> {
  const marker = await writer.createItem({
    type: "core.note",
    properties: { body: "cursor marker" },
  } as Parameters<MarfaClient["createItem"]>[0]);
  expect(marker.status, JSON.stringify(marker.error)).toBe(201);
  const events = await readFrom("0", (seen) =>
    seen.some(
      (e) => e.event === "item.created" && itemOf(e) === marker.data.item.id,
    ),
  );
  const frame = events.find(
    (e) => e.event === "item.created" && itemOf(e) === marker.data.item.id,
  );
  expect(frame?.id).toBeDefined();
  return frame!.id!;
}

function readFrom(
  cursor: string,
  until: (events: SseEvent[]) => boolean,
): Promise<SseEvent[]> {
  return withStream(
    server.apiUrl,
    server.workingKey,
    { lastEventId: cursor },
    async (stream) =>
      (
        await collectUntil(
          stream,
          until,
          `a frame ending the read from ${cursor}`,
        )
      ).events,
  );
}
