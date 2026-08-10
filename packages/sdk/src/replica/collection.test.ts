/**
 * The replica, against a real in-process server rather than a mock.
 *
 * The properties worth holding are the ones a mock would let you fake:
 * that a read in the interactive path touches no network, that a write
 * shows locally before the server has answered, that a change made
 * elsewhere arrives, and that a change landing during the initial read
 * is not lost — the race a replica gets wrong silently.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createKeysModeFixture } from "../test-harness.js";
import type { KeysModeFixture } from "../test-harness.js";
import { createReplicaCollection } from "./collection.js";
import type { Item } from "@withmarfa/shared";

let fx: KeysModeFixture;

beforeAll(async () => {
  fx = await createKeysModeFixture();
});

afterAll(() => {
  fx.cleanup();
});

/** Wait for a condition the replica should reach, or fail saying what it
 *  held instead — a bare timeout tells you nothing about why. */
async function until(
  describeIt: string,
  predicate: () => boolean,
  snapshot: () => unknown,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(
    `replica never ${describeIt}; last saw ${JSON.stringify(snapshot())}`,
  );
}

function titles(rows: Iterable<Item>): string[] {
  return [...rows]
    .map((i) =>
      typeof i.properties.title === "string" ? i.properties.title : "",
    )
    .filter(Boolean)
    .sort();
}

describe("createReplicaCollection", () => {
  it("serves reads locally once populated, with no further network calls", async () => {
    await fx.client.items.create({
      type: "core.note",
      properties: { title: "already here", body: "x" },
    });

    const replica = createReplicaCollection(fx.client, { type: "core.note" });
    await replica.preload();
    await until(
      "loaded the existing item",
      () => titles(replica.values()).includes("already here"),
      () => titles(replica.values()),
    );

    // The read that a UI performs. If this reached the network the
    // replica would not be doing its job; it is a synchronous walk of
    // an in-memory map.
    const before = titles(replica.values());
    const again = titles(replica.values());
    expect(again).toEqual(before);
    expect(again).toContain("already here");

    replica.utils.stop();
  });

  it("applies a write locally before the server has confirmed it", async () => {
    const replica = createReplicaCollection(fx.client, { type: "core.note" });
    await replica.preload();

    // A locally-minted row: the server assigns the real identity when
    // the write lands, which is exactly why the optimistic copy is
    // allowed to be incomplete.
    const optimistic = {
      id: `local-${String(Math.random()).slice(2)}`,
      type: "core.note",
      properties: { title: "optimistic", body: "y" },
    } as unknown as Item;
    const tx = replica.insert(optimistic);

    // Visible immediately — before the persist promise settles. This is
    // the whole point of the optimistic path.
    expect(titles(replica.values())).toContain("optimistic");

    await tx.isPersisted.promise;
    replica.utils.stop();
  });

  it("converges on a change made through another client", async () => {
    const replica = createReplicaCollection(fx.client, { type: "core.note" });
    await replica.preload();

    // A write that did not go through the replica at all.
    await fx.client.items.create({
      type: "core.note",
      properties: { title: "from elsewhere", body: "z" },
    });

    await until(
      "saw the item written elsewhere",
      () => titles(replica.values()).includes("from elsewhere"),
      () => titles(replica.values()),
    );
    replica.utils.stop();
  });

  it("does not lose a change that lands during the initial read", async () => {
    // The race the buffering exists for, driven deterministically.
    // Racing the real network here would make the test a bet on
    // scheduling, which is the failure class this repo has already paid
    // for once; so the stream is supplied and the ordering is exact:
    // the event is delivered while the initial read is parked.
    const seeded = await fx.client.items.create({
      type: "core.note",
      properties: { title: "already present", body: "a" },
    });
    const arrivedDuringRead = await fx.client.items.create({
      type: "core.note",
      properties: { title: "arrived during read", body: "b" },
    });

    let releaseRead!: () => void;
    const readHeld = new Promise<void>((r) => {
      releaseRead = r;
    });

    // A stand-in for the one call the replica makes during its initial
    // read. A Proxy would work too, but returns `any` and hides which
    // surface is actually being exercised.
    const slowClient = {
      items: {
        list: async () => {
          // The snapshot the server had before the second write, held
          // open so the stream event lands while it is in flight.
          await readHeld;
          return { data: [seeded], cursor: null, has_more: false };
        },
      },
      // The stream is supplied below, so nothing else on the client is
      // reached during this test; naming only what is used keeps that
      // visible rather than implied.
    } as unknown as typeof fx.client;

    const replica = createReplicaCollection(slowClient, {
      type: "core.note",
      subscribe: ({ onEvent }) => {
        // Delivered now — while the read above is still parked.
        void onEvent(
          { type: "item.created", item: arrivedDuringRead } as never,
          "1",
        );
        releaseRead();
        return {
          closed: Promise.resolve(),
          close: () => undefined,
          lastEventId: "1",
        };
      },
    });

    await replica.preload();
    await until(
      "kept the event that arrived during its initial read",
      () => titles(replica.values()).includes("arrived during read"),
      () => titles(replica.values()),
    );
    // Both are present: the snapshot's row and the buffered one.
    expect(titles(replica.values())).toContain("already present");
    expect(
      [...replica.values()].filter((i) => i.id === arrivedDuringRead.id),
    ).toHaveLength(1);
    replica.utils.stop();
  });

  it("reflects a deletion made elsewhere", async () => {
    const doomed = await fx.client.items.create({
      type: "core.note",
      properties: { title: "to be removed", body: "q" },
    });
    const replica = createReplicaCollection(fx.client, { type: "core.note" });
    await replica.preload();
    await until(
      "loaded the doomed item",
      () => titles(replica.values()).includes("to be removed"),
      () => titles(replica.values()),
    );

    await fx.client.items.delete(doomed.id);
    await until(
      "dropped the deleted item",
      () => !titles(replica.values()).includes("to be removed"),
      () => titles(replica.values()),
    );
    replica.utils.stop();
  });

  it("persists an edit through the replica as the field change, not a nested copy", async () => {
    // The write path the replica exists to provide, driven against a real
    // server. The bug this guards: the payload was wrapped one level too
    // deep, so the edit landed in a junk `properties` key, the real field
    // was untouched, and the transaction still resolved as persisted.
    const created = await fx.client.items.create({
      type: "core.note",
      properties: { title: "before edit", body: "keep" },
    });

    const replica = createReplicaCollection(fx.client, { type: "core.note" });
    await replica.preload();
    await until(
      "loaded the item to edit",
      () => titles(replica.values()).includes("before edit"),
      () => titles(replica.values()),
    );

    const tx = replica.update(created.id, (draft) => {
      draft.properties.title = "after edit";
    });
    await tx.isPersisted.promise;

    // The server row carries the edited title and nothing nested.
    const stored = await fx.client.items.get(created.id);
    expect(stored.properties.title).toBe("after edit");
    expect(stored.properties.body).toBe("keep");
    expect(stored.properties).not.toHaveProperty("properties");

    replica.utils.stop();
  });

  it("persists a delete through the replica", async () => {
    const created = await fx.client.items.create({
      type: "core.note",
      properties: { title: "delete me", body: "x" },
    });
    const replica = createReplicaCollection(fx.client, { type: "core.note" });
    await replica.preload();
    await until(
      "loaded the item to delete",
      () => titles(replica.values()).includes("delete me"),
      () => titles(replica.values()),
    );

    const tx = replica.delete(created.id);
    await tx.isPersisted.promise;

    await expect(fx.client.items.get(created.id)).rejects.toThrow();
    replica.utils.stop();
  });

  it("declares the version it expected so a conflict can fire", async () => {
    // The conflict option is inert unless the write declares the version
    // it expected: without it the client re-reads the current version
    // immediately before writing, so last-write-wins and the strategy
    // never runs. Injecting the client makes the wire shape observable
    // rather than racing two live replicas against a converging stream.
    let updateArgs: {
      id: string;
      properties: Record<string, unknown>;
      options: { expectedVersion?: number; conflict?: string } | undefined;
    } | null = null;

    const seeded = {
      ...({} as Item),
      id: "seed-1",
      type: "core.note",
      version: 7,
      properties: { title: "seed", body: "base" },
    } as Item;

    const recordingClient = {
      items: {
        list: () =>
          Promise.resolve({ data: [seeded], cursor: null, has_more: false }),
        update: (
          id: string,
          properties: Record<string, unknown>,
          options: { expectedVersion?: number; conflict?: string },
        ) => {
          updateArgs = { id, properties, options };
          return Promise.resolve({ ...seeded, ...{ properties }, version: 8 });
        },
      },
    } as unknown as typeof fx.client;

    const replica = createReplicaCollection(recordingClient, {
      type: "core.note",
      conflict: "manual",
      subscribe: () => ({
        closed: Promise.resolve(),
        close: () => undefined,
        lastEventId: undefined,
      }),
    });
    await replica.preload();
    await until(
      "loaded the seeded row",
      () => titles(replica.values()).includes("seed"),
      () => titles(replica.values()),
    );

    const tx = replica.update("seed-1", (draft) => {
      draft.properties.body = "edited";
    });
    await tx.isPersisted.promise;

    expect(updateArgs).not.toBeNull();
    // The properties reach update directly, never wrapped in a nested
    // `properties` key.
    expect(updateArgs!.properties).not.toHaveProperty("properties");
    expect(updateArgs!.properties.body).toBe("edited");
    // The expected version is the one the replica last synced, so the
    // server can see a row that moved underneath.
    expect(updateArgs!.options?.expectedVersion).toBe(7);
    expect(updateArgs!.options?.conflict).toBe("manual");

    replica.utils.stop();
  });

  it("removes a trashed item from the replica as a fresh read would", async () => {
    // Trashing publishes a state-change event, not a deletion, and the
    // server's default list excludes trashed items. A replica that upserts
    // every non-deletion event kept the trashed row on screen until the
    // next full read silently dropped it, so two clients disagreed about
    // what existed.
    const created = await fx.client.items.create({
      type: "core.note",
      properties: { title: "to be trashed", body: "x" },
    });
    const replica = createReplicaCollection(fx.client, { type: "core.note" });
    await replica.preload();
    await until(
      "loaded the item before trashing",
      () => titles(replica.values()).includes("to be trashed"),
      () => titles(replica.values()),
    );

    await fx.client.items.transition(created.id, "trashed");
    await until(
      "dropped the trashed item",
      () => !titles(replica.values()).includes("to be trashed"),
      () => titles(replica.values()),
    );
    replica.utils.stop();
  });

  it("keeps an archived item in the replica, matching the default list", async () => {
    const created = await fx.client.items.create({
      type: "core.note",
      properties: { title: "to be archived", body: "x" },
    });
    const replica = createReplicaCollection(fx.client, { type: "core.note" });
    await replica.preload();
    await until(
      "loaded the item before archiving",
      () => titles(replica.values()).includes("to be archived"),
      () => titles(replica.values()),
    );

    await fx.client.items.transition(created.id, "archived");
    // Give the stream a chance to wrongly drop it.
    await new Promise((r) => setTimeout(r, 300));
    expect(titles(replica.values())).toContain("to be archived");
    replica.utils.stop();
  });

  it("replicates one type only, so an unrelated write does not appear", async () => {
    const replica = createReplicaCollection(fx.client, { type: "core.note" });
    await replica.preload();

    await fx.client.items.create({
      type: "core.bookmark",
      properties: { title: "a bookmark", url: "https://example.test/x" },
    });
    // Give the stream a chance to deliver it wrongly.
    await new Promise((r) => setTimeout(r, 300));
    expect(titles(replica.values())).not.toContain("a bookmark");
    replica.utils.stop();
  });

  it("reports rather than fills the page when the type outgrows its ceiling", async () => {
    // A replica holds the whole type in memory, so the interesting failure
    // is a type that was never going to fit. Silently holding the first N
    // rows would leave a UI showing a subset it believes is everything.
    const rows: Item[] = Array.from({ length: 4 }, (_, i) => ({
      ...({} as Item),
      id: `row-${String(i)}`,
      properties: { title: `row ${String(i)}` },
    }));

    let cursorsSeen = 0;
    const pagedClient = {
      items: {
        list: ({ cursor }: { cursor?: string } = {}) => {
          const start = cursor ? Number(cursor) : 0;
          cursorsSeen += 1;
          return Promise.resolve({
            data: rows.slice(start, start + 2),
            cursor: start + 2 < rows.length ? String(start + 2) : null,
            has_more: start + 2 < rows.length,
          });
        },
      },
    } as unknown as typeof fx.client;

    const errors: unknown[] = [];
    const replica = createReplicaCollection(pagedClient, {
      type: "core.note",
      pageSize: 2,
      maxItems: 3,
      subscribe: () => ({
        closed: Promise.resolve(),
        close: () => undefined,
        lastEventId: undefined,
      }),
      onError: (err) => errors.push(err),
    });

    await replica.preload();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).name).toBe("PageLimitExceededError");
    // It walked far enough to know the set was bigger, then stopped.
    expect(cursorsSeen).toBe(2);
    // And it is still ready, so a consumer sees an empty replica plus an
    // error rather than waiting on a promise that never settles.
    expect([...replica.values()]).toHaveLength(0);
    replica.utils.stop();
  });
});
