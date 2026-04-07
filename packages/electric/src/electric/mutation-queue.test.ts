import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { createLocalConnection } from "../local/connection.js";
import type { LocalDb } from "../local/connection.js";
import { MutationQueue } from "./mutation-queue.js";
import { MymeClient } from "@myme/sdk";
import { mutationQueue } from "../local/schema.js";

let db: LocalDb;
let close: () => void;

beforeAll(() => {
  const conn = createLocalConnection(":memory:");
  db = conn.db;
  close = conn.close;
});

afterAll(() => {
  close();
});

beforeEach(() => {
  // Clear the queue between tests
  db.delete(mutationQueue).run();
});

function createMockClient(): MymeClient {
  return {
    items: {
      create: vi.fn().mockResolvedValue({ id: "test-id" }),
      update: vi.fn().mockResolvedValue({ id: "test-id" }),
      delete: vi.fn().mockResolvedValue(undefined),
      restore: vi.fn().mockResolvedValue({ id: "test-id" }),
      transition: vi.fn().mockResolvedValue({ id: "test-id" }),
    },
    metadata: {
      addTags: vi
        .fn()
        .mockResolvedValue({ item_id: "test-id", tags: [], about: [] }),
      removeTag: vi.fn().mockResolvedValue(undefined),
      set: vi
        .fn()
        .mockResolvedValue({ item_id: "test-id", tags: [], about: [] }),
    },
  } as unknown as MymeClient;
}

describe("MutationQueue", () => {
  it("enqueues and flushes mutations", async () => {
    const client = createMockClient();
    const queue = new MutationQueue(db, client);

    queue.enqueue("create", "item", "item-1", {
      type: "core.note",
      properties: { body: "test" },
    });

    expect(queue.pendingCount()).toBe(1);

    const result = await queue.flush();
    expect(result.replayed).toBe(1);
    expect(result.failed).toBe(0);
    expect(queue.pendingCount()).toBe(0);

    expect(client.items.create).toHaveBeenCalledOnce();
  });

  it("processes mutations in FIFO order", async () => {
    const client = createMockClient();
    const queue = new MutationQueue(db, client);
    const order: string[] = [];

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    (client.items.create as ReturnType<typeof vi.fn>).mockImplementation(() => {
      order.push("create");
      return Promise.resolve({ id: "id" });
    });
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    (client.items.delete as ReturnType<typeof vi.fn>).mockImplementation(() => {
      order.push("delete");
      return Promise.resolve(undefined);
    });

    queue.enqueue("create", "item", "item-1", {
      type: "core.note",
      properties: { body: "a" },
    });
    queue.enqueue("delete", "item", "item-2", {});

    await queue.flush();
    expect(order).toEqual(["create", "delete"]);
  });

  it("stops on network error", async () => {
    const client = createMockClient();
    const queue = new MutationQueue(db, client);

    (client.items.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new TypeError("fetch failed"),
    );

    queue.enqueue("create", "item", "item-1", {
      type: "core.note",
      properties: { body: "a" },
    });
    queue.enqueue("create", "item", "item-2", {
      type: "core.note",
      properties: { body: "b" },
    });

    const result = await queue.flush();
    // First mutation retried (network), second not attempted
    expect(result.replayed).toBe(0);
    expect(queue.pendingCount()).toBe(2);
  });

  it("treats duplicate errors as success", async () => {
    const client = createMockClient();
    const queue = new MutationQueue(db, client);

    (client.items.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("duplicate_source"),
    );

    queue.enqueue("create", "item", "item-1", {
      type: "core.note",
      properties: { body: "a" },
    });

    const result = await queue.flush();
    expect(result.replayed).toBe(1);
    expect(queue.pendingCount()).toBe(0);
  });

  it("handles different mutation operations", async () => {
    const client = createMockClient();
    const queue = new MutationQueue(db, client);

    queue.enqueue("update", "item", "item-1", {
      properties: { body: "new" },
      version: 2,
    });
    queue.enqueue("transition", "item", "item-1", { state: "archived" });
    queue.enqueue("tag", "item", "item-1", { tags: ["test"] });
    queue.enqueue("untag", "item", "item-1", { tag: "old" });

    const result = await queue.flush();
    expect(result.replayed).toBe(4);

    expect(client.items.update).toHaveBeenCalledOnce();
    expect(client.items.transition).toHaveBeenCalledOnce();
    expect(client.metadata.addTags).toHaveBeenCalledOnce();
    expect(client.metadata.removeTag).toHaveBeenCalledOnce();
  });
});
