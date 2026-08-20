/**
 * Handler-level tests for the Raindrop inbound integration.
 *
 * Coverage:
 *   - Collections sweep upserts; parent-of edges between nested
 *     collections built on second pass once all mappings exist.
 *   - Raindrops sweep upserts; parent-of edges from collection →
 *     raindrop on first write.
 *   - Pagination + watermark break on `last_created_at`.
 *   - Field translation: source/type rename, nested cover, tags
 *     array, media filter.
 */
import { describe, it, expect } from "vitest";
import {
  createCursorStore,
  createActivitySink,
  createEchoSuppression,
  type ConnectionContext,
  type ConnectionClient,
  type CreateItemInput,
  type ItemResource,
  type ItemState,
  type ScheduleMessage,
  familyOnlyMappingResolver,
} from "@withmarfa/runtime-sdk";
import { handleSchedule, __internals } from "./handlers.js";

interface InMemoryStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

function memStorage(): InMemoryStorage {
  const d = new Map<string, unknown>();
  return {
    get: (k) => Promise.resolve(d.get(k)),
    put: (k, v) => {
      d.set(k, v);
      return Promise.resolve();
    },
    delete: (k) => Promise.resolve(d.delete(k)),
  };
}

interface BuildOpts {
  proxyResponses: (() => Response)[];
}

interface BuiltState {
  ctx: ConnectionContext;
  created: CreateItemInput[];
  updated: { id: string; patch: Partial<CreateItemInput> }[];
  edges: { source_id: string; target_id: string; edge_type: string }[];
  emitted: { type: string; properties?: Record<string, unknown> }[];
  proxyCalls: { method: string; path: string }[];
}

function buildContext(opts: BuildOpts): BuiltState {
  const storage = memStorage();
  const created: CreateItemInput[] = [];
  const updated: { id: string; patch: Partial<CreateItemInput> }[] = [];
  const edges: {
    source_id: string;
    target_id: string;
    edge_type: string;
  }[] = [];
  const emitted: { type: string; properties?: Record<string, unknown> }[] = [];
  const proxyCalls: { method: string; path: string }[] = [];
  let proxyIdx = 0;
  const connectionId = "conn_raindrop_test";

  const client = {
    createItem: (input: CreateItemInput) => {
      if (input.type === "system.activity") {
        emitted.push({ type: input.type, properties: input.properties });
        return Promise.resolve({ id: "act_x", type: input.type });
      }
      created.push(input);
      return Promise.resolve({
        id: `mit_${String(created.length)}`,
        type: input.type,
      });
    },
    updateItem: (id: string, patch: Partial<CreateItemInput>) => {
      updated.push({ id, patch });
      return Promise.resolve({ id, type: "raindrop.raindrop" });
    },
    getItem: () => Promise.resolve(null as unknown as ItemResource | null),
    transitionItem: (id: string, to: ItemState) =>
      Promise.resolve({ id, type: "raindrop.raindrop", state: to }),
    proxyRequest: (method: string, path: string) => {
      proxyCalls.push({ method, path });
      const responder = opts.proxyResponses[proxyIdx];
      proxyIdx += 1;
      if (!responder) {
        return Promise.resolve(new Response("no responder", { status: 500 }));
      }
      return Promise.resolve(responder());
    },
    createEdge: (input: {
      source_id: string;
      target_id: string;
      edge_type: string;
    }) => {
      edges.push(input);
      return Promise.resolve({ id: `edg_${String(edges.length)}` });
    },
    ensureEdge: (input: {
      source_id: string;
      target_id: string;
      edge_type: string;
    }) => {
      edges.push(input);
      return Promise.resolve("created" as const);
    },
  } as unknown as ConnectionClient;

  const ctx: ConnectionContext = {
    connection_id: connectionId,
    integration_name: "raindrop.bookmarks",
    marfa: client,
    cursor: createCursorStore(storage),
    activity: createActivitySink(client, connectionId),
    echo: createEchoSuppression(storage, {
      echo_ttl_seconds: 1,
      lag_window_seconds: 1,
    }),
    mapping: familyOnlyMappingResolver(),
    cycle: null,
  };
  return { ctx, created, updated, edges, emitted, proxyCalls };
}

const SCHEDULE_MSG = (): ScheduleMessage => ({
  kind: "schedule",
  integration_name: "raindrop.bookmarks",
  connection_id: "conn_raindrop_test",
  scheduled_for_ms: Date.now(),
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("Raindrop handlers — inbound", () => {
  it("upserts collections, raindrops + wires parent-of edges, persists cursor", async () => {
    const collectionsResp = {
      items: [
        { _id: 1001, title: "Tech", count: 2 },
        { _id: 1002, title: "Cooking", count: 1, parent: { $id: 1001 } },
      ],
    };
    const childrenResp = { items: [] };
    const raindropsPage1 = {
      result: true,
      items: [
        {
          _id: 9001,
          title: "Rust book",
          link: "https://example.com/rust",
          excerpt: "Excellent.",
          tags: ["systems", "rust"],
          domain: "example.com",
          type: "article",
          collection: { $id: 1001 },
          created: "2026-05-20T10:00:00Z",
          lastUpdate: "2026-05-20T10:00:00Z",
          important: true,
        },
        {
          _id: 9002,
          title: "Pasta tips",
          link: "https://example.com/pasta",
          collection: { $id: 1002 },
          created: "2026-05-19T11:00:00Z",
          lastUpdate: "2026-05-19T11:00:00Z",
        },
      ],
    };
    const { ctx, created, edges, emitted, proxyCalls } = buildContext({
      proxyResponses: [
        () => jsonResponse(collectionsResp),
        () => jsonResponse(childrenResp),
        () => jsonResponse(raindropsPage1),
      ],
    });

    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result).toEqual({ ok: true });

    const cols = created.filter((c) => c.type === "raindrop.collection");
    expect(cols).toHaveLength(2);
    expect(cols[0]?.properties).toMatchObject({ title: "Tech" });
    expect(cols[1]?.properties).toMatchObject({
      title: "Cooking",
      parent_id: "1001",
    });

    const rdrops = created.filter((c) => c.type === "raindrop.raindrop");
    expect(rdrops).toHaveLength(2);
    expect(rdrops[0]?.properties).toMatchObject({
      title: "Rust book",
      url: "https://example.com/rust",
      domain: "example.com",
      raindrop_type: "article",
      tags: ["systems", "rust"],
      important: true,
      collection_id: "1001",
    });

    // Edges: nested collection (Tech → Cooking) + 2 raindrop edges.
    expect(edges.length).toBeGreaterThanOrEqual(3);
    expect(
      edges.find(
        (e) =>
          e.edge_type === "parent-of" &&
          e.source_id === "mit_1" &&
          e.target_id === "mit_2",
      ),
    ).toBeDefined();

    // Watermark advanced to the newest raindrop's created timestamp.
    const cursor = (await ctx.cursor.read("main")) as {
      last_created_at: string;
    };
    expect(cursor.last_created_at).toBe("2026-05-20T10:00:00Z");

    // Activity summary carries the non-destructive assertion.
    const last = emitted.at(-1);
    expect(
      (last?.properties as { summary?: string } | undefined)?.summary ?? "",
    ).toContain(
      "no destructive operations performed against pre-existing data",
    );

    // 3 proxy calls: 2 collection endpoints + 1 raindrops page.
    expect(proxyCalls).toHaveLength(3);
    expect(proxyCalls[0]?.path).toBe("/rest/v1/collections");
    expect(proxyCalls[1]?.path).toBe("/rest/v1/collections/childrens");
    expect(proxyCalls[2]?.path).toMatch(
      /\/rest\/v1\/raindrops\/0\?sort=-created/,
    );
  });

  it("watermark break stops paging when items become older than the cursor", async () => {
    const { ctx, created, proxyCalls } = buildContext({
      proxyResponses: [
        () => jsonResponse({ items: [] }),
        () => jsonResponse({ items: [] }),
        () =>
          jsonResponse({
            items: [
              {
                _id: 1,
                title: "newer",
                link: "https://example.com/new",
                created: "2026-05-25T00:00:00Z",
                collection: { $id: 1 },
              },
              {
                _id: 2,
                title: "older",
                link: "https://example.com/old",
                created: "2026-05-10T00:00:00Z",
                collection: { $id: 1 },
              },
            ],
          }),
      ],
    });
    // Pre-seed cursor with a watermark between the two items.
    await ctx.cursor.write("main", {
      last_created_at: "2026-05-15T00:00:00Z",
      raindrop_mappings: {},
      collection_mappings: {},
      last_collection_sweep_at: null,
      last_inbound_at: null,
    });

    await handleSchedule(ctx, SCHEDULE_MSG());
    const rdrops = created.filter((c) => c.type === "raindrop.raindrop");
    expect(rdrops).toHaveLength(1); // Only the newer one.
    // Only one raindrops page fetched (broke out of loop).
    expect(
      proxyCalls.filter((p) => p.path.includes("/raindrops/0")),
    ).toHaveLength(1);
  });

  it("buildCollectionInput normalizes cover array → first string", () => {
    const input = __internals.buildCollectionInput({
      _id: 7,
      title: "X",
      cover: ["https://covers.example/a.jpg", "https://covers.example/b.jpg"],
    });
    expect(input.properties?.cover).toBe("https://covers.example/a.jpg");
  });

  it("buildRaindropInput renames Raindrop's `type` to `raindrop_type` (avoid Item-column shadow)", () => {
    const input = __internals.buildRaindropInput({
      _id: 1,
      title: "X",
      link: "https://example.com",
      type: "video",
    });
    expect(input.properties?.raindrop_type).toBe("video");
    expect(input.properties?.type).toBeUndefined();
  });

  it("buildRaindropInput mirrors note → body for core.bookmark compatibility", () => {
    const input = __internals.buildRaindropInput({
      _id: 1,
      title: "X",
      link: "https://example.com",
      note: "my note",
    });
    expect(input.properties?.body).toBe("my note");
    expect(input.properties?.note).toBe("my note");
  });

  it("buildRaindropInput keeps media entries with `link` only", () => {
    const input = __internals.buildRaindropInput({
      _id: 1,
      title: "X",
      link: "https://example.com",
      media: [
        { link: "https://example.com/img.png", type: "image" },
        { type: "audio" }, // no link — should be filtered out
        { link: "https://example.com/clip.mp4" },
      ],
    });
    expect(input.properties?.media).toEqual([
      { link: "https://example.com/img.png", type: "image" },
      { link: "https://example.com/clip.mp4" },
    ]);
  });
});
