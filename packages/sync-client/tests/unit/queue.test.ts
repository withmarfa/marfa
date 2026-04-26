import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MymeSyncClient } from "../../src/client.js";
import { MutationQueue } from "../../src/queue/queue.js";
import type { PGliteWithSync } from "../../src/storage/pglite.js";

let client: MymeSyncClient;
let queue: MutationQueue;
let pg: PGliteWithSync;

beforeEach(async () => {
  client = new MymeSyncClient({
    apiUrl: "http://localhost:0",
    apiKey: "myme_k1_test",
    storage: "memory",
    autoStartSync: false,
  });
  await client.start();
  pg = client.db;
  queue = new MutationQueue(pg);
});

afterEach(async () => {
  await client.stop();
});

describe("MutationQueue", () => {
  it("enqueue assigns a UUIDv7 write_id and persists the row", async () => {
    const id = await queue.enqueue({
      kind: "createItem",
      payload: { input: { type: "core.note", properties: { body: "hi" } } },
    });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    expect(await queue.size()).toBe(1);
  });

  it("takeNext returns rows in FIFO order and marks them in-flight", async () => {
    const a = await queue.enqueue({
      kind: "createItem",
      payload: { input: { type: "core.note", properties: {} } },
    });
    await new Promise((r) => setTimeout(r, 2));
    const b = await queue.enqueue({
      kind: "deleteItem",
      payload: { id: "x" },
    });

    const first = await queue.takeNext();
    expect(first?.write_id).toBe(a);
    expect(first?.state).toBe("in_flight");

    const second = await queue.takeNext();
    expect(second?.write_id).toBe(b);

    const third = await queue.takeNext();
    expect(third).toBeNull();
  });

  it("recordFailure increments attempt_count and resets state to pending", async () => {
    const id = await queue.enqueue({
      kind: "deleteItem",
      payload: { id: "x" },
    });
    await queue.takeNext();
    await queue.recordFailure(id, "network down");
    const pending = await queue.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.attempt_count).toBe(1);
    expect(pending[0]?.last_error).toBe("network down");
    expect(pending[0]?.state).toBe("pending");
  });

  it("remove deletes the row", async () => {
    const id = await queue.enqueue({
      kind: "deleteItem",
      payload: { id: "x" },
    });
    await queue.remove(id);
    expect(await queue.size()).toBe(0);
  });

  it("cascadeDrop removes all rows targeting a given id", async () => {
    const id = "item-1";
    await queue.enqueue(
      { kind: "createItem", payload: { input: { type: "core.note", properties: {} } } },
      { targetId: id },
    );
    await queue.enqueue(
      { kind: "updateItem", payload: { id, properties: { body: "hi" } } },
      { targetId: id },
    );
    await queue.enqueue(
      { kind: "deleteItem", payload: { id } },
      { targetId: id },
    );
    // unrelated mutation should survive
    await queue.enqueue(
      { kind: "createItem", payload: { input: { type: "core.note", properties: {} } } },
      { targetId: "item-2" },
    );

    const dropped = await queue.cascadeDrop(id);
    expect(dropped).toHaveLength(3);
    expect(await queue.size()).toBe(1);
  });
});
