/**
 * Handler-level tests for the Readwise inbound integration.
 *
 * Builds ConnectionContext inline. Mocks ctx.myme entirely. Tests
 * cover:
 *   - First-run sweep upserts books + highlights, creates parent-of
 *     edges, advances the updated_after watermark.
 *   - Second-run sweep with persisted cursor uses the new watermark
 *     and produces no new creates when payload is empty.
 *   - is_deleted books and highlights are skipped (tombstone_mapping
 *     ignore).
 *   - Pagination via nextPageCursor.
 *   - Activity summary line carries the read-only assertion.
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
} from "@mymehq/runtime-sdk";
import { handleSchedule, __internals } from "./handlers.js";

interface InMemoryStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

function createMemoryStorage(): InMemoryStorage {
  // By-value get/put (T-257) mirrors real Cloudflare DO storage —
  // every value is structured-cloned on the way in and out so handlers
  // can't mutate stored objects by reference. Without this the
  // "second sweep uses persisted watermark" test flakes whenever the
  // wall clock ticks between the test's cursor read and the second
  // sweep's mutate-then-write of the same object reference.
  const data = new Map<string, unknown>();
  return {
    get(key) {
      const v = data.get(key);
      return Promise.resolve(v === undefined ? undefined : structuredClone(v));
    },
    put(key, value) {
      data.set(key, structuredClone(value));
      return Promise.resolve();
    },
    delete(key) {
      return Promise.resolve(data.delete(key));
    },
  };
}

interface CapturedActivity {
  type: string;
  properties?: Record<string, unknown>;
}

interface ProxyCall {
  method: string;
  path: string;
}

interface EdgeCall {
  source_id: string;
  target_id: string;
  edge_type: string;
}

interface BuildOpts {
  proxyResponses: (() => Response)[];
}

interface BuiltContext {
  ctx: ConnectionContext;
  emitted: CapturedActivity[];
  created: CreateItemInput[];
  updated: { id: string; patch: Partial<CreateItemInput> }[];
  proxyCalls: ProxyCall[];
  edgeCalls: EdgeCall[];
}

function buildContext(opts: BuildOpts): BuiltContext {
  const storage = createMemoryStorage();
  const emitted: CapturedActivity[] = [];
  const created: CreateItemInput[] = [];
  const updated: { id: string; patch: Partial<CreateItemInput> }[] = [];
  const proxyCalls: ProxyCall[] = [];
  const edgeCalls: EdgeCall[] = [];
  let proxyIdx = 0;
  const connectionId = "conn_readwise_test";

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
      return Promise.resolve({ id, type: "readwise.book" });
    },
    getItem: () => Promise.resolve(null as unknown as ItemResource | null),
    transitionItem: (id: string, to: ItemState) =>
      Promise.resolve({ id, type: "readwise.highlight", state: to }),
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
      edgeCalls.push(input);
      return Promise.resolve({ id: `edg_${String(edgeCalls.length)}` });
    },
  } as unknown as ConnectionClient;

  const ctx: ConnectionContext = {
    connection_id: connectionId,
    integration_name: "readwise.highlights",
    myme: client,
    cursor: createCursorStore(storage),
    activity: createActivitySink(client, connectionId),
    echo: createEchoSuppression(storage, {
      echo_ttl_seconds: 1,
      lag_window_seconds: 1,
    }),
    cycle: null,
  };
  return { ctx, emitted, created, updated, proxyCalls, edgeCalls };
}

const SCHEDULE_MSG = (): ScheduleMessage => ({
  kind: "schedule",
  integration_name: "readwise.highlights",
  connection_id: "conn_readwise_test",
  scheduled_for_ms: Date.now(),
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const SAMPLE_PAYLOAD = {
  count: 1,
  nextPageCursor: null,
  results: [
    {
      user_book_id: 42001,
      title: "The Pragmatic Programmer",
      author: "David Thomas, Andrew Hunt",
      category: "books",
      source: "kindle",
      source_url: "https://amazon.com/p1",
      cover_image_url: "https://covers.example/p1.jpg",
      num_highlights: 2,
      updated: "2026-05-20T12:00:00Z",
      highlights: [
        {
          id: 1001,
          text: "Avoid duplication.",
          note: "DRY is everywhere.",
          location: 12,
          location_type: "location",
          color: "yellow",
          tags: [{ name: "principle" }],
          highlighted_at: "2026-05-20T11:55:00Z",
          updated_at: "2026-05-20T11:55:00Z",
          url: "https://readwise.io/h/1001",
        },
        {
          id: 1002,
          text: "Tracer bullets light up the night.",
          note: null,
          location: 38,
          location_type: "location",
          color: "yellow",
          tags: [],
          highlighted_at: "2026-05-20T11:56:00Z",
          updated_at: "2026-05-20T11:56:00Z",
        },
      ],
    },
  ],
};

describe("Readwise handlers — inbound", () => {
  it("upserts books + highlights, creates parent-of edges, persists cursor on first run", async () => {
    const { ctx, created, edgeCalls, proxyCalls, emitted } = buildContext({
      proxyResponses: [() => jsonResponse(SAMPLE_PAYLOAD)],
    });

    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result).toEqual({ ok: true });

    // 1 book + 2 highlights = 3 createItem calls
    expect(created).toHaveLength(3);
    expect(created[0]?.type).toBe("readwise.book");
    expect(created[1]?.type).toBe("readwise.highlight");
    expect(created[2]?.type).toBe("readwise.highlight");

    // Both highlights have the book's myme_id as parent-of source.
    expect(edgeCalls).toHaveLength(2);
    expect(edgeCalls[0]).toMatchObject({
      source_id: "mit_1",
      target_id: "mit_2",
      edge_type: "parent-of",
    });
    expect(edgeCalls[1]).toMatchObject({
      source_id: "mit_1",
      target_id: "mit_3",
      edge_type: "parent-of",
    });

    // First request uses the far-past sentinel.
    expect(proxyCalls[0]!.method).toBe("GET");
    expect(proxyCalls[0]!.path).toMatch(
      /updatedAfter=1970-01-01T00%3A00%3A00Z/,
    );

    // Cursor watermark advanced past the far-past sentinel.
    const cursor = (await ctx.cursor.read("main")) as {
      updated_after: string;
      book_mappings: Record<string, string>;
      highlight_mappings: Record<string, string>;
    };
    expect(cursor.updated_after).not.toBe("1970-01-01T00:00:00Z");
    expect(cursor.book_mappings["42001"]).toBe("mit_1");
    expect(cursor.highlight_mappings["1001"]).toBe("mit_2");
    expect(cursor.highlight_mappings["1002"]).toBe("mit_3");

    // Activity summary carries the read-only assertion.
    const last = emitted.at(-1);
    expect(
      typeof last?.properties?.summary === "string"
        ? last.properties.summary
        : "",
    ).toContain(
      "no destructive operations performed against the live Readwise account",
    );
  });

  it("second sweep uses persisted watermark + no-ops on empty payload", async () => {
    const { ctx, proxyCalls, created } = buildContext({
      proxyResponses: [
        () => jsonResponse(SAMPLE_PAYLOAD),
        () => jsonResponse({ count: 0, nextPageCursor: null, results: [] }),
      ],
    });
    await handleSchedule(ctx, SCHEDULE_MSG());
    const cursorAfter1 = (await ctx.cursor.read("main")) as {
      updated_after: string;
    };
    const beforeSecond = created.length;
    await handleSchedule(ctx, SCHEDULE_MSG());
    const afterSecond = created.length;
    expect(afterSecond - beforeSecond).toBe(0);
    // The second sweep advances the watermark again.
    const cursorAfter2 = (await ctx.cursor.read("main")) as {
      updated_after: string;
    };
    expect(cursorAfter2.updated_after >= cursorAfter1.updated_after).toBe(true);
    // Second proxy call used the persisted watermark.
    expect(proxyCalls[1]!.path).toContain(
      encodeURIComponent(cursorAfter1.updated_after),
    );
  });

  it("skips is_deleted books and is_deleted highlights (tombstone_mapping: ignore)", async () => {
    const payload = {
      count: 2,
      nextPageCursor: null,
      results: [
        { user_book_id: 99001, is_deleted: true, title: "Deleted book" },
        {
          user_book_id: 99002,
          title: "Live book",
          highlights: [
            { id: 2001, text: "alive", updated_at: "2026-05-20T12:00:00Z" },
            { id: 2002, is_deleted: true, text: "skip me" },
          ],
        },
      ],
    };
    const { ctx, created, edgeCalls } = buildContext({
      proxyResponses: [() => jsonResponse(payload)],
    });
    await handleSchedule(ctx, SCHEDULE_MSG());
    // Only the live book + 1 live highlight + 1 edge.
    expect(created.filter((c) => c.type === "readwise.book")).toHaveLength(1);
    expect(created.filter((c) => c.type === "readwise.highlight")).toHaveLength(
      1,
    );
    expect(edgeCalls).toHaveLength(1);
  });

  it("follows nextPageCursor for paginated payloads", async () => {
    const page1 = {
      nextPageCursor: "cursor_p2",
      results: [
        { user_book_id: 1, title: "B1", highlights: [{ id: 11, text: "h1" }] },
      ],
    };
    const page2 = {
      nextPageCursor: null,
      results: [
        { user_book_id: 2, title: "B2", highlights: [{ id: 22, text: "h2" }] },
      ],
    };
    const { ctx, created, proxyCalls } = buildContext({
      proxyResponses: [() => jsonResponse(page1), () => jsonResponse(page2)],
    });
    await handleSchedule(ctx, SCHEDULE_MSG());
    expect(proxyCalls).toHaveLength(2);
    expect(proxyCalls[1]!.path).toContain("pageCursor=cursor_p2");
    expect(created.filter((c) => c.type === "readwise.book")).toHaveLength(2);
  });

  it("returns retry=true on /export 5xx", async () => {
    const { ctx } = buildContext({
      proxyResponses: [() => new Response("upstream broke", { status: 503 })],
    });
    const result = await handleSchedule(ctx, SCHEDULE_MSG());
    expect(result).toMatchObject({ ok: false, retry: true });
  });

  it("buildBookInput renames Readwise's `source` to `readwise_source` to avoid Item-column shadow", () => {
    const input = __internals.buildBookInput({
      user_book_id: 7,
      title: "X",
      source: "kindle",
    });
    expect(input.properties?.readwise_source).toBe("kindle");
    expect(input.properties).not.toHaveProperty("source");
  });

  it("normaliseTags handles both string[] and { name }[] shapes", () => {
    expect(__internals.normaliseTags(["a", "b"])).toEqual(["a", "b"]);
    expect(__internals.normaliseTags([{ name: "x" }, { name: "y" }])).toEqual([
      "x",
      "y",
    ]);
    expect(__internals.normaliseTags(undefined)).toEqual([]);
  });
});
