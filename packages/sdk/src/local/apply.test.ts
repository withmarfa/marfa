/**
 * What an inbound event is allowed to change.
 *
 * Driven with hand-built events rather than a live stream, because the
 * rules here are about the payload the store is handed: the version it
 * carries, the layer it may reach, and what it leaves the cursor at. The
 * stream that carries them is exercised in `stream.test.ts`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Edge, Item } from "@withmarfa/shared";
import type { MarfaEvent } from "../events.js";
import { applyEvent } from "./apply.js";
import { openLocalStore, type LocalStore } from "./store/index.js";
import { SINGLE_ACCOUNT, SINGLE_SPACE } from "./types.js";

let dir: string;
let store: LocalStore;

const identity = {
  origin: "http://localhost",
  spaceId: SINGLE_SPACE,
  accountId: SINGLE_ACCOUNT,
};

const ITEM_ID = "01a00000-0000-7000-8000-0000000000a1";
const EDGE_ID = "01a00000-0000-7000-8000-0000000000e1";

function item(overrides: Partial<Item> = {}): Item {
  return {
    id: ITEM_ID,
    type: "core.note",
    state: "active",
    properties: { body: "as the server has it" },
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    timestamp: "2026-09-01T00:00:00.000Z",
    source: "test",
    version: 5,
    schema_version: 1,
    ...overrides,
  };
}

function edge(overrides: Partial<Edge> = {}): Edge {
  return {
    id: EDGE_ID,
    edge_type: "references",
    source_id: ITEM_ID,
    target_id: "01a00000-0000-7000-8000-0000000000a2",
    properties: {},
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    version: 3,
    ...overrides,
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "marfa-local-apply-"));
  store = await openLocalStore({ path: join(dir, "store.db"), identity });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the version an event carries", () => {
  it("refuses a payload older than the row held", async () => {
    await store.server.items.put(item({ version: 5 }));

    const stale: MarfaEvent = {
      type: "item.updated",
      item: item({ version: 4, properties: { body: "from further back" } }),
    };
    expect(await applyEvent(store, stale, "12")).toBe("stale");

    expect(await store.server.items.get(ITEM_ID)).toMatchObject({
      version: 5,
      properties: { body: "as the server has it" },
    });
  });

  it("applies a payload at the version held", async () => {
    await store.server.items.put(item({ version: 5 }));

    // Not "strictly newer". Delivery is at-least-once and the catch-up
    // read overlaps the stream on purpose, so the same row arriving twice
    // is the ordinary case rather than a fault, and refusing it would make
    // the second delivery of a row the client had not yet stored a
    // permanent loss.
    const same: MarfaEvent = {
      type: "item.updated",
      item: item({ version: 5, properties: { body: "delivered twice" } }),
    };
    expect(await applyEvent(store, same, "13")).toBe("applied");
    expect(await store.server.items.get(ITEM_ID)).toMatchObject({
      properties: { body: "delivered twice" },
    });
  });

  it("compares an edge the same way", async () => {
    await store.server.edges.put(edge({ version: 3 }));

    const stale: MarfaEvent = {
      type: "edge.updated",
      edge: edge({ version: 2, properties: { note: "from further back" } }),
    };
    expect(await applyEvent(store, stale, "14")).toBe("stale");
    expect(await store.server.edges.get(EDGE_ID)).toMatchObject({
      version: 3,
      properties: {},
    });
  });
});

describe("which layer an event may reach", () => {
  it("leaves tags and extensions alone when an item event carries them", async () => {
    await store.server.items.put(item({ version: 5 }));
    await store.server.metadata.put({
      item_id: ITEM_ID,
      tags: ["kept"],
      extensions: { "app.notes": { pinned: true } },
    });

    // The field is populated on the wire on some occasions and carries no
    // tags and no extensions on any of them. Writing it from here would
    // erase the sidecar on every ordinary edit, which is the whole reason
    // the two layers are separate tables.
    const withSidecar: MarfaEvent = {
      type: "item.updated",
      item: item({ version: 6, properties: { body: "edited elsewhere" } }),
      metadata: { item_id: ITEM_ID, tags: [], extensions: {} },
    };
    expect(await applyEvent(store, withSidecar, "15")).toBe("applied");

    expect(await store.server.metadata.get(ITEM_ID)).toEqual({
      item_id: ITEM_ID,
      tags: ["kept"],
      extensions: { "app.notes": { pinned: true } },
    });
    expect(await store.server.items.get(ITEM_ID)).toMatchObject({
      version: 6,
      properties: { body: "edited elsewhere" },
    });
  });

  it("writes the sidecar only from the event that owns it", async () => {
    await store.server.items.put(item({ version: 5 }));

    const changed: MarfaEvent = {
      type: "metadata.changed",
      item: item({ version: 9, properties: { body: "not from here" } }),
      metadata: { item_id: ITEM_ID, tags: ["added"], extensions: {} },
    };
    expect(await applyEvent(store, changed, "16")).toBe("applied");

    expect(await store.server.metadata.get(ITEM_ID)).toMatchObject({
      tags: ["added"],
    });
    // The item half is not taken. A tag change bumps the row's modification
    // time, so the payload rides along on an event that is not a report
    // about the item — and a second writer for one layer is how the two
    // start disagreeing.
    expect(await store.server.items.get(ITEM_ID)).toMatchObject({
      version: 5,
      properties: { body: "as the server has it" },
    });
  });
});

describe("a removal that reaches a client", () => {
  it("keeps a trashed row and drops a purged one", async () => {
    await store.server.items.put(item({ version: 5 }));

    const trashed: MarfaEvent = {
      type: "item.deleted",
      item: item({ version: 6, state: "trashed" }),
    };
    await applyEvent(store, trashed, "17");
    // Trash is real state a restore can bring back, and hydration reads
    // every state, so dropping it here would make the two paths disagree
    // about what the server holds.
    expect(await store.server.items.get(ITEM_ID)).toMatchObject({
      state: "trashed",
    });

    const purged: MarfaEvent = {
      type: "item.purged",
      item: item({ version: 6, state: "trashed" }),
    };
    await applyEvent(store, purged, "18");
    expect(await store.server.items.get(ITEM_ID)).toBeUndefined();
  });

  it("takes an edge out with no version to argue about", async () => {
    await store.server.edges.put(edge({ version: 3 }));
    // The payload on a removal describes the row as it last stood, so
    // comparing versions would refuse exactly the deliveries that arrive
    // after something else already moved the row on.
    await applyEvent(
      store,
      { type: "edge.deleted", edge: edge({ version: 1 }) },
      "19",
    );
    expect(await store.server.edges.get(EDGE_ID)).toBeUndefined();
  });
});

describe("where the stream has reached", () => {
  it("moves the cursor with the event and not ahead of it", async () => {
    await applyEvent(store, { type: "item.created", item: item() }, "20");
    expect((await store.syncState.read(identity))?.cursor).toBe("20");

    // One write, so nothing can land between them. A store that recorded
    // the cursor first and then failed to apply would come back believing
    // it held an event it never took.
    const refuses: MarfaEvent = {
      type: "edge.created",
      // Refused by handing the store a payload it cannot serialize,
      // rather than by leaning on a constraint the schema may not have.
      // What the refusal is does not matter here; that the cursor does not
      // move past it does.
      edge: edge({ properties: { unserializable: 1n } }),
    };
    await expect(applyEvent(store, refuses, "21")).rejects.toThrow();
    expect((await store.syncState.read(identity))?.cursor).toBe("20");
  });
});
