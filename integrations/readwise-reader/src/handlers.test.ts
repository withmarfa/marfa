/**
 * Handler-level tests for the Readwise Reader integration.
 *
 * Builds ConnectionContext inline with a memory-backed cursor, activity
 * sink and echo store, and a mocked `ctx.marfa` that serves a queue of
 * canned upstream responses.
 *
 * Several cases exist because the live API behaves differently from its
 * documentation, and each of those is labelled with what was actually
 * observed. They are the ones most worth keeping: a refactor that
 * "simplifies" any of them reintroduces a real defect.
 */
import { describe, it, expect } from "vitest";
import {
  createCursorStore,
  createActivitySink,
  createEchoSuppression,
  type ConnectionContext,
  type ConnectionClient,
  type BulkUpsertResponse,
  type CreateItemInput,
  type ItemResource,
  type ItemState,
  type ScheduleMessage,
  type ItemEventMessage,
  familyOnlyMappingResolver,
} from "@withmarfa/runtime-sdk";
import { handleSchedule, handleItemEvent, __internals } from "./handlers.js";
import { FABRICATED_URL_PREFIX, MAX_PAGES_PER_SWEEP } from "./manifest.js";

const CONNECTION_ID = "conn_reader_test";

interface InMemoryStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

function createMemoryStorage(): InMemoryStorage {
  // By-value get/put mirrors real Durable Object storage, so a handler
  // cannot mutate stored state by reference and make a later assertion
  // pass for the wrong reason.
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
  body?: unknown;
}

interface BulkCall {
  items: CreateItemInput[];
}

interface BuildOpts {
  proxyResponses: (() => Response)[];
  /**
   * Per-call behaviour for `bulkUpsertItems`, indexed by call order.
   * A function returning a response overrides the default all-created
   * outcome; a function that throws simulates the page not landing.
   * Falls through to the default once exhausted.
   */
  bulkBehaviour?: ((items: CreateItemInput[]) => BulkUpsertResponse)[];
  /** Items `getItem` should answer with, keyed by id. */
  items?: Record<string, ItemResource | null>;
  /** `properties.configuration` on the connection item. */
  configuration?: Record<string, unknown>;
  storage?: InMemoryStorage;
}

interface BuiltContext {
  ctx: ConnectionContext;
  storage: InMemoryStorage;
  emitted: CapturedActivity[];
  created: CreateItemInput[];
  updated: { id: string; patch: Partial<CreateItemInput> }[];
  proxyCalls: ProxyCall[];
  bulkCalls: BulkCall[];
}

function buildContext(opts: BuildOpts): BuiltContext {
  const storage = opts.storage ?? createMemoryStorage();
  const emitted: CapturedActivity[] = [];
  const created: CreateItemInput[] = [];
  const updated: { id: string; patch: Partial<CreateItemInput> }[] = [];
  const proxyCalls: ProxyCall[] = [];
  const bulkCalls: BulkCall[] = [];
  let proxyIdx = 0;
  let bulkIdx = 0;

  const connectionItem = {
    id: CONNECTION_ID,
    type: "system.connection",
    properties: { configuration: opts.configuration ?? {} },
  } as unknown as ItemResource;

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
    bulkUpsertItems: (items: CreateItemInput[]) => {
      bulkCalls.push({ items });
      const behaviour = opts.bulkBehaviour?.[bulkIdx];
      bulkIdx += 1;
      if (behaviour) return Promise.resolve(behaviour(items));
      // Default: every entry created, ids handed back in input order and
      // in the same shape `createItem` uses, so assertions that predate
      // batching keep meaning what they meant.
      const results = items.map((input, index) => {
        created.push(input);
        return {
          index,
          outcome: "created" as const,
          id: `mit_${String(created.length)}`,
        };
      });
      return Promise.resolve({
        counts: {
          created: results.length,
          updated: 0,
          skipped: 0,
          errored: 0,
        },
        results,
      });
    },
    updateItem: (id: string, patch: Partial<CreateItemInput>) => {
      updated.push({ id, patch });
      return Promise.resolve({ id, type: "readwise.document" });
    },
    getItem: (id: string) => {
      if (id === CONNECTION_ID) return Promise.resolve(connectionItem);
      return Promise.resolve(opts.items?.[id] ?? null);
    },
    transitionItem: (id: string, to: ItemState) =>
      Promise.resolve({ id, type: "readwise.document", state: to }),
    proxyRequest: (method: string, path: string, body?: unknown) => {
      proxyCalls.push({ method, path, body });
      const responder = opts.proxyResponses[proxyIdx];
      proxyIdx += 1;
      if (!responder) {
        return Promise.resolve(new Response("no responder", { status: 500 }));
      }
      return Promise.resolve(responder());
    },
  } as unknown as ConnectionClient;

  const ctx: ConnectionContext = {
    connection_id: CONNECTION_ID,
    integration_name: "readwise.reader",
    marfa: client,
    cursor: createCursorStore(storage),
    activity: createActivitySink(client, CONNECTION_ID),
    echo: createEchoSuppression(storage, {
      echo_ttl_seconds: 120,
      lag_window_seconds: 600,
    }),
    mapping: familyOnlyMappingResolver(),
    cycle: null,
  };
  return { ctx, storage, emitted, created, updated, proxyCalls, bulkCalls };
}

const SCHEDULE_MSG = (): ScheduleMessage => ({
  kind: "schedule",
  integration_name: "readwise.reader",
  connection_id: CONNECTION_ID,
  scheduled_for_ms: Date.now(),
});

function itemEventMsg(
  item_id: string,
  originating = "conn_other",
): ItemEventMessage {
  return {
    kind: "item-event",
    integration_name: "readwise.reader",
    connection_id: CONNECTION_ID,
    event_type: "item.updated",
    item_id,
    cycle: { originating_connection_id: originating, hop_count: 1 },
  } as unknown as ItemEventMessage;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function doc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "doc_1",
    url: "https://read.readwise.io/read/doc_1",
    source_url: "https://example.com/a",
    title: "An article",
    author: "A Writer",
    summary: "A summary",
    category: "article",
    location: "later",
    site_name: "Example",
    source: "Reader Share Sheet iOS",
    word_count: 900,
    reading_time: "4 mins",
    listening_time: null,
    reading_progress: 0.5,
    published_date: "2026-08-01",
    image_url: "https://example.com/a.jpg",
    notes: "",
    tags: {},
    parent_id: null,
    saved_at: "2026-08-01T10:00:00+00:00",
    updated_at: "2026-08-02T10:00:00+00:00",
    last_moved_at: "2026-08-01T10:05:00+00:00",
    first_opened_at: null,
    last_opened_at: null,
    ...over,
  };
}

function marfaItem(
  id: string,
  properties: Record<string, unknown>,
  state = "active",
): ItemResource {
  return {
    id,
    type: "readwise.document",
    state,
    properties,
  } as unknown as ItemResource;
}

async function readCursor(storage: InMemoryStorage): Promise<{
  updated_after: string;
  page_cursor: string | null;
  doc_mappings: Record<string, string>;
}> {
  const store = createCursorStore(storage);
  return (await store.read("main")) as {
    updated_after: string;
    page_cursor: string | null;
    doc_mappings: Record<string, string>;
  };
}

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

describe("inbound sweep", () => {
  it("mirrors an in-scope document, maps it, and advances the watermark", async () => {
    const built = buildContext({
      proxyResponses: [
        () => json({ count: 1, nextPageCursor: null, results: [doc()] }),
      ],
    });
    const result = await handleSchedule(built.ctx, SCHEDULE_MSG());
    expect(result).toEqual({ ok: true });
    expect(built.created).toHaveLength(1);
    expect(built.created[0]?.type).toBe("readwise.document");
    expect(built.created[0]?.properties?.title).toBe("An article");
    expect(built.created[0]?.source_id).toBe("doc_1");

    const cursor = await readCursor(built.storage);
    expect(cursor.doc_mappings.doc_1).toBe("mit_1");
    expect(cursor.page_cursor).toBeNull();
    expect(cursor.updated_after).not.toBe("1970-01-01T00:00:00Z");
  });

  it("skips documents that are children of another document", async () => {
    const built = buildContext({
      proxyResponses: [
        () =>
          json({
            nextPageCursor: null,
            results: [doc({ id: "d_child", parent_id: "doc_1" })],
          }),
      ],
    });
    await handleSchedule(built.ctx, SCHEDULE_MSG());
    expect(built.created).toHaveLength(0);
  });

  it("skips highlight and note categories even when they have no parent", async () => {
    // A real library carries an orphaned highlight with no parent_id.
    // The parent check alone would let it through.
    const built = buildContext({
      proxyResponses: [
        () =>
          json({
            nextPageCursor: null,
            results: [
              doc({ id: "d_h", category: "highlight", parent_id: null }),
              doc({ id: "d_n", category: "note", parent_id: null }),
            ],
          }),
      ],
    });
    await handleSchedule(built.ctx, SCHEDULE_MSG());
    expect(built.created).toHaveLength(0);
  });

  it("skips feed documents by default", async () => {
    const built = buildContext({
      proxyResponses: [
        () =>
          json({
            nextPageCursor: null,
            results: [doc({ id: "d_feed", location: "feed" })],
          }),
      ],
    });
    await handleSchedule(built.ctx, SCHEDULE_MSG());
    expect(built.created).toHaveLength(0);
  });

  it("mirrors feed documents when include_feed is configured on", async () => {
    const built = buildContext({
      configuration: { include_feed: true },
      proxyResponses: [
        () =>
          json({
            nextPageCursor: null,
            results: [doc({ id: "d_feed", location: "feed" })],
          }),
      ],
    });
    await handleSchedule(built.ctx, SCHEDULE_MSG());
    expect(built.created).toHaveLength(1);
  });

  it("normalizes the tag dictionary Reader returns into a sorted name list", async () => {
    // Observed shape: keyed by name, each value an object carrying the
    // name plus bookkeeping. Writes take a plain list, so the two have
    // to be reconciled somewhere.
    const built = buildContext({
      proxyResponses: [
        () =>
          json({
            nextPageCursor: null,
            results: [
              doc({
                tags: {
                  youtube: { name: "youtube", type: "public_api", created: 1 },
                  alpha: { name: "alpha", type: "public_api", created: 2 },
                },
              }),
            ],
          }),
      ],
    });
    await handleSchedule(built.ctx, SCHEDULE_MSG());
    expect(built.created[0]?.properties?.tags).toEqual(["alpha", "youtube"]);
  });

  it("drops an empty image_url rather than writing it to a url field", async () => {
    // 42 documents in a real library carry `image_url: ""`, which fails
    // url validation and would reject the whole item.
    const built = buildContext({
      proxyResponses: [
        () => json({ nextPageCursor: null, results: [doc({ image_url: "" })] }),
      ],
    });
    await handleSchedule(built.ctx, SCHEDULE_MSG());
    expect(built.created[0]?.properties).not.toHaveProperty("image_url");
  });

  it("does not write a fabricated source URL back onto the item", async () => {
    const built = buildContext({
      proxyResponses: [
        () =>
          json({
            nextPageCursor: null,
            results: [doc({ source_url: `${FABRICATED_URL_PREFIX}mit_9` })],
          }),
      ],
    });
    await handleSchedule(built.ctx, SCHEDULE_MSG());
    expect(built.created[0]?.properties).not.toHaveProperty("source_url");
  });

  it("parks the page cursor without advancing the watermark when a sweep runs long", async () => {
    // Advancing the watermark on a parked sweep would permanently skip
    // everything past the point it stopped.
    const responses = Array.from(
      { length: MAX_PAGES_PER_SWEEP },
      (_, i) => () =>
        json({
          nextPageCursor: `cur_${String(i + 1)}`,
          results: [doc({ id: `d_${String(i)}` })],
        }),
    );
    const built = buildContext({ proxyResponses: responses });
    await handleSchedule(built.ctx, SCHEDULE_MSG());

    const cursor = await readCursor(built.storage);
    expect(cursor.page_cursor).toBe(`cur_${String(MAX_PAGES_PER_SWEEP)}`);
    expect(cursor.updated_after).toBe("1970-01-01T00:00:00Z");
    expect(built.created).toHaveLength(MAX_PAGES_PER_SWEEP);
  });

  it("resumes from a parked page cursor on the next tick", async () => {
    const storage = createMemoryStorage();
    const first = buildContext({
      storage,
      proxyResponses: [
        () => json({ nextPageCursor: "cur_a", results: [doc({ id: "d_a" })] }),
        ...Array.from(
          { length: MAX_PAGES_PER_SWEEP - 1 },
          (_, i) => () =>
            json({
              nextPageCursor: `cur_${String(i + 2)}`,
              results: [doc({ id: `d_b${String(i)}` })],
            }),
        ),
      ],
    });
    await handleSchedule(first.ctx, SCHEDULE_MSG());

    const second = buildContext({
      storage,
      proxyResponses: [
        () => json({ nextPageCursor: null, results: [doc({ id: "d_last" })] }),
      ],
    });
    await handleSchedule(second.ctx, SCHEDULE_MSG());

    expect(second.proxyCalls[0]?.path).toContain(
      `pageCursor=cur_${String(MAX_PAGES_PER_SWEEP)}`,
    );
    const cursor = await readCursor(storage);
    expect(cursor.page_cursor).toBeNull();
    expect(cursor.updated_after).not.toBe("1970-01-01T00:00:00Z");
  });

  it("parks rather than retrying when the list bucket throttles", async () => {
    // A queue retry lands inside the same rate-limit window and spends
    // the budget the next tick needs.
    const built = buildContext({
      proxyResponses: [
        () => json({ nextPageCursor: "cur_x", results: [doc()] }),
        () => new Response("throttled", { status: 429 }),
      ],
    });
    const result = await handleSchedule(built.ctx, SCHEDULE_MSG());
    expect(result).toEqual({ ok: true });

    const cursor = await readCursor(built.storage);
    expect(cursor.page_cursor).toBe("cur_x");
    expect(cursor.updated_after).toBe("1970-01-01T00:00:00Z");
    const summary = built.emitted.at(-1)?.properties?.summary;
    expect(String(summary)).toContain("parked");
  });

  it("skips a document this integration just wrote", async () => {
    const built = buildContext({
      proxyResponses: [() => json({ nextPageCursor: null, results: [doc()] })],
    });
    const hash = await __internals.contentHashForDocument(doc() as never);
    await built.ctx.echo.trackOutboundWrite("doc_1", hash);

    await handleSchedule(built.ctx, SCHEDULE_MSG());
    expect(built.created).toHaveLength(0);
    expect(built.updated).toHaveLength(0);
  });

  it("re-syncs a mapped document through the same upsert, carrying its source_id", async () => {
    // The handler no longer branches on its own mapping table. Every
    // document goes through the one upsert and the server resolves
    // `(source, source_id)` — which is what makes a mapping lost with a
    // dying sweep harmless rather than a duplicate.
    const storage = createMemoryStorage();
    const first = buildContext({
      storage,
      proxyResponses: [() => json({ nextPageCursor: null, results: [doc()] })],
    });
    await handleSchedule(first.ctx, SCHEDULE_MSG());

    const second = buildContext({
      storage,
      proxyResponses: [
        () =>
          json({
            nextPageCursor: null,
            results: [doc({ title: "Retitled upstream" })],
          }),
      ],
      bulkBehaviour: [
        (items) => ({
          counts: { created: 0, updated: items.length, skipped: 0, errored: 0 },
          results: items.map((_, index) => ({
            index,
            outcome: "updated" as const,
            id: "mit_1",
          })),
        }),
      ],
    });
    await handleSchedule(second.ctx, SCHEDULE_MSG());

    expect(second.bulkCalls).toHaveLength(1);
    expect(second.bulkCalls[0]?.items).toHaveLength(1);
    expect(second.bulkCalls[0]?.items[0]?.source_id).toBe("doc_1");
    expect(second.bulkCalls[0]?.items[0]?.properties?.title).toBe(
      "Retitled upstream",
    );
    const cursor = (await second.ctx.cursor.read("main")) as {
      doc_mappings: Record<string, string>;
    };
    expect(cursor.doc_mappings.doc_1).toBe("mit_1");
  });

  it("resumes from the page it reached when a sweep dies mid-drain", async () => {
    // The regression this integration actually shipped: a backfill over a
    // library of several thousand documents cannot finish inside one
    // sweep, so sweeps die partway. Progress has to survive that. It only
    // does if the cursor is checkpointed per page rather than once at the
    // end of the drain.
    const storage = createMemoryStorage();
    const first = buildContext({
      storage,
      proxyResponses: [
        () => json({ nextPageCursor: "page_2", results: [doc({ id: "d1" })] }),
        () => json({ nextPageCursor: "page_3", results: [doc({ id: "d2" })] }),
        () => json({ nextPageCursor: "page_4", results: [doc({ id: "d3" })] }),
      ],
      bulkBehaviour: [
        undefined as unknown as (
          items: CreateItemInput[],
        ) => BulkUpsertResponse,
        undefined as unknown as (
          items: CreateItemInput[],
        ) => BulkUpsertResponse,
        () => {
          throw new Error("container suddenly disconnected");
        },
      ],
    });

    const result = await handleSchedule(first.ctx, SCHEDULE_MSG());
    expect(result).toEqual({
      ok: false,
      retry: true,
      reason: "reader inbound bulk upsert failed",
    });

    // Two pages applied, and the checkpoint records the third as the
    // place to pick up — not the start of the library.
    const parked = (await first.ctx.cursor.read("main")) as {
      page_cursor: string | null;
      updated_after: string;
      doc_mappings: Record<string, string>;
    };
    expect(parked.page_cursor).toBe("page_3");
    expect(Object.keys(parked.doc_mappings)).toEqual(["d1", "d2"]);

    const second = buildContext({
      storage,
      proxyResponses: [
        () => json({ nextPageCursor: null, results: [doc({ id: "d3" })] }),
      ],
    });
    await handleSchedule(second.ctx, SCHEDULE_MSG());

    // The resumed sweep asks for page three, rather than re-walking the
    // two pages already applied.
    expect(second.proxyCalls[0]?.path).toContain("pageCursor=page_3");
    expect(second.created).toHaveLength(1);
    expect(second.created[0]?.source_id).toBe("d3");
  });

  it("writes one request per page rather than one per document", async () => {
    // A request per document is what turns six hundred documents into an
    // hour of work, which is longer than a sweep gets.
    const built = buildContext({
      proxyResponses: [
        () =>
          json({
            nextPageCursor: null,
            results: [
              doc({ id: "d1" }),
              doc({ id: "d2" }),
              doc({ id: "d3" }),
              doc({ id: "d4" }),
            ],
          }),
      ],
    });
    await handleSchedule(built.ctx, SCHEDULE_MSG());
    expect(built.bulkCalls).toHaveLength(1);
    expect(built.bulkCalls[0]?.items).toHaveLength(4);
  });

  it("holds the watermark when a document in the page failed to write", async () => {
    // Advancing over a document that did not land strands it: nothing
    // fetches it again unless it changes upstream.
    const storage = createMemoryStorage();
    const built = buildContext({
      storage,
      proxyResponses: [
        () =>
          json({
            nextPageCursor: null,
            results: [doc({ id: "d1" }), doc({ id: "d2" })],
          }),
      ],
      bulkBehaviour: [
        () => ({
          counts: { created: 1, updated: 0, skipped: 0, errored: 1 },
          results: [
            { index: 0, outcome: "created" as const, id: "mit_1" },
            {
              index: 1,
              outcome: "errored" as const,
              error: { code: "validation_error", message: "bad document" },
            },
          ],
        }),
      ],
    });
    await handleSchedule(built.ctx, SCHEDULE_MSG());

    const cursor = (await built.ctx.cursor.read("main")) as {
      updated_after: string;
      doc_mappings: Record<string, string>;
    };
    expect(cursor.updated_after).toBe("1970-01-01T00:00:00Z");
    expect(cursor.doc_mappings.d1).toBe("mit_1");
    expect(cursor.doc_mappings.d2).toBeUndefined();

    const summary = built.emitted.at(-1)?.properties as
      | { detail?: { failed?: number } }
      | undefined;
    expect(summary?.detail?.failed).toBe(1);
  });

  it("keeps holding the watermark when the failure was in an earlier sweep", async () => {
    // A backfill spans several sweeps. A failure on the first sweep has
    // to still be remembered when a later sweep reaches the end of the
    // stream and decides whether the pass was clean, or the document
    // that failed is stepped over and stranded.
    const storage = createMemoryStorage();

    const first = buildContext({
      storage,
      proxyResponses: [
        () =>
          json({
            nextPageCursor: "page_2",
            results: [doc({ id: "d1" }), doc({ id: "d2" })],
          }),
      ],
      bulkBehaviour: [
        () => ({
          counts: { created: 1, updated: 0, skipped: 0, errored: 1 },
          results: [
            { index: 0, outcome: "created" as const, id: "mit_1" },
            {
              index: 1,
              outcome: "errored" as const,
              error: { code: "validation_error", message: "bad document" },
            },
          ],
        }),
      ],
    });
    await handleSchedule(first.ctx, SCHEDULE_MSG());

    // A later sweep finishes the stream cleanly. The watermark must
    // still not move — the earlier failure is what it is waiting on.
    const second = buildContext({
      storage,
      proxyResponses: [
        () => json({ nextPageCursor: null, results: [doc({ id: "d3" })] }),
      ],
    });
    await handleSchedule(second.ctx, SCHEDULE_MSG());

    const held = (await second.ctx.cursor.read("main")) as {
      updated_after: string;
      retried_after_failure: boolean;
    };
    expect(held.updated_after).toBe("1970-01-01T00:00:00Z");
    expect(held.retried_after_failure).toBe(true);

    // The retry pass completes cleanly, so now it moves.
    const third = buildContext({
      storage,
      proxyResponses: [
        () => json({ nextPageCursor: null, results: [doc({ id: "d3" })] }),
      ],
    });
    await handleSchedule(third.ctx, SCHEDULE_MSG());
    const moved = (await third.ctx.cursor.read("main")) as {
      updated_after: string;
      retried_after_failure: boolean;
    };
    expect(moved.updated_after).not.toBe("1970-01-01T00:00:00Z");
    expect(moved.retried_after_failure).toBe(false);
  });

  it("stops holding after one retry, so a document Marfa always refuses cannot pin the watermark", async () => {
    // Holding forever would re-walk the entire library on every tick for
    // the sake of one document that will never be accepted. The
    // action_required rows are the record instead.
    const storage = createMemoryStorage();
    const failing = () => ({
      counts: { created: 0, updated: 0, skipped: 0, errored: 1 },
      results: [
        {
          index: 0,
          outcome: "errored" as const,
          error: { code: "validation_error", message: "always bad" },
        },
      ],
    });

    for (const pass of [1, 2]) {
      const built = buildContext({
        storage,
        proxyResponses: [
          () => json({ nextPageCursor: null, results: [doc({ id: "dx" })] }),
        ],
        bulkBehaviour: [failing],
      });
      await handleSchedule(built.ctx, SCHEDULE_MSG());
      const c = (await built.ctx.cursor.read("main")) as {
        updated_after: string;
      };
      if (pass === 1) {
        expect(c.updated_after).toBe("1970-01-01T00:00:00Z");
      } else {
        expect(c.updated_after).not.toBe("1970-01-01T00:00:00Z");
      }
    }
  });

  it("does nothing on an empty sweep", async () => {
    const built = buildContext({
      proxyResponses: [() => json({ nextPageCursor: null, results: [] })],
    });
    const result = await handleSchedule(built.ctx, SCHEDULE_MSG());
    expect(result).toEqual({ ok: true });
    expect(built.created).toHaveLength(0);
  });

  it("retries on a server error and does not move the watermark", async () => {
    const built = buildContext({
      proxyResponses: [() => new Response("boom", { status: 503 })],
    });
    const result = await handleSchedule(built.ctx, SCHEDULE_MSG());
    expect(result).toMatchObject({ ok: false, retry: true });
  });
});

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

describe("outbound item events", () => {
  it("saves a new document and records the mapping", async () => {
    const built = buildContext({
      items: {
        mit_1: marfaItem("mit_1", {
          title: "From Marfa",
          source_url: "https://example.com/x",
        }),
      },
      proxyResponses: [
        () => json({ id: "doc_new", url: "https://read.readwise.io/x" }, 201),
        () => json({ results: [doc({ id: "doc_new" })] }),
      ],
    });
    const result = await handleItemEvent(built.ctx, itemEventMsg("mit_1"));
    expect(result).toEqual({ ok: true });

    const save = built.proxyCalls[0];
    expect(save?.method).toBe("POST");
    expect(save?.path).toContain("/save/");
    expect((save?.body as { url?: string }).url).toBe("https://example.com/x");

    const cursor = await readCursor(built.storage);
    expect(cursor.doc_mappings.doc_new).toBe("mit_1");
  });

  it("fabricates a stable, non-resolvable URL for an item with no source, and supplies body html", async () => {
    // Reader requires a URL and deduplicates on it, so a retry must
    // present the same one or it creates a second document. The html is
    // what stops Reader fetching a host that cannot resolve.
    const build = () =>
      buildContext({
        items: { mit_7: marfaItem("mit_7", { title: "No source" }) },
        proxyResponses: [
          () => json({ id: "doc_f", url: "https://read.readwise.io/f" }, 201),
          () => json({ results: [doc({ id: "doc_f" })] }),
        ],
      });

    const a = build();
    await handleItemEvent(a.ctx, itemEventMsg("mit_7"));
    const b = build();
    await handleItemEvent(b.ctx, itemEventMsg("mit_7"));

    const urlA = (a.proxyCalls[0]?.body as { url: string }).url;
    const urlB = (b.proxyCalls[0]?.body as { url: string }).url;
    expect(urlA).toBe(`${FABRICATED_URL_PREFIX}mit_7`);
    expect(urlB).toBe(urlA);
    expect((a.proxyCalls[0]?.body as { html?: string }).html).toContain(
      "No source",
    );
  });

  it("creates a document that has no author, which is the ordinary case", async () => {
    // Reader refuses a save carrying `should_clean_html: false` unless
    // BOTH author and title are present, and an author is optional on
    // this type. Sending the flag rejected every authorless document
    // with a 400 naming a field the writer never had to supply.
    const built = buildContext({
      items: { mit_9: marfaItem("mit_9", { title: "No author here" }) },
      proxyResponses: [
        () => json({ id: "doc_na" }, 201),
        () => json({ results: [doc({ id: "doc_na" })] }),
      ],
    });
    const result = await handleItemEvent(built.ctx, itemEventMsg("mit_9"));
    expect(result).toEqual({ ok: true });

    const save = built.proxyCalls[0]?.body as Record<string, unknown>;
    expect(save).toHaveProperty("html");
    expect(save).not.toHaveProperty("should_clean_html");
    expect(save).not.toHaveProperty("author");
  });

  it("adopts an existing document on a 200 and then updates it, because a re-save changes nothing", async () => {
    // Observed: POST /save/ on a known URL returns 200 with the existing
    // id and mutates no field. Treating that as a successful write would
    // silently do nothing.
    const built = buildContext({
      items: {
        mit_2: marfaItem("mit_2", {
          title: "Adopt me",
          source_url: "https://example.com/known",
        }),
      },
      proxyResponses: [
        () => json({ id: "doc_known", url: "https://read.readwise.io/k" }, 200),
        () => json({ id: "doc_known", url: "https://read.readwise.io/k" }, 200),
        () => json({ results: [doc({ id: "doc_known" })] }),
      ],
    });
    await handleItemEvent(built.ctx, itemEventMsg("mit_2"));

    expect(built.proxyCalls[0]?.method).toBe("POST");
    const patch = built.proxyCalls[1];
    expect(patch?.method).toBe("PATCH");
    expect(patch?.path).toContain("/update/doc_known/");
    expect((patch?.body as { title?: string }).title).toBe("Adopt me");
  });

  it("updates a mapped document and takes the echo hash from a read-back", async () => {
    // The update response carries only {id, url}, so the hash cannot
    // come from it. It also would not capture a location Reader
    // rewrote on the way in.
    const storage = createMemoryStorage();
    const seed = buildContext({
      storage,
      proxyResponses: [() => json({ nextPageCursor: null, results: [doc()] })],
    });
    await handleSchedule(seed.ctx, SCHEDULE_MSG());

    const stored = doc({ location: "new" });
    const built = buildContext({
      storage,
      items: {
        mit_1: marfaItem("mit_1", { title: "Edited", location: "archive" }),
      },
      proxyResponses: [
        () => json({ id: "doc_1", url: "https://read.readwise.io/doc_1" }),
        () => json({ results: [stored] }),
      ],
    });
    await handleItemEvent(built.ctx, itemEventMsg("mit_1"));

    expect(built.proxyCalls[0]?.method).toBe("PATCH");
    expect(built.proxyCalls[1]?.path).toContain("id=doc_1");

    // The hash recorded is the stored document's, so the sweep that
    // follows recognises what Reader actually holds.
    const hash = await __internals.contentHashForDocument(stored as never);
    expect(await built.ctx.echo.shouldSkipReactive("doc_1", hash)).toBe(true);
  });

  it("never sends shortlist as a location", async () => {
    // Reader answers 201 and silently stores `new`, so this cannot be
    // caught downstream.
    const built = buildContext({
      items: {
        mit_3: marfaItem("mit_3", { title: "S", location: "shortlist" }),
      },
      proxyResponses: [
        () => json({ id: "doc_s" }, 201),
        () => json({ results: [doc({ id: "doc_s" })] }),
      ],
    });
    await handleItemEvent(built.ctx, itemEventMsg("mit_3"));
    expect(built.proxyCalls[0]?.body).not.toHaveProperty("location");
  });

  it("omits tags entirely when the item carries none, because a tag write replaces the set", async () => {
    const built = buildContext({
      items: { mit_4: marfaItem("mit_4", { title: "No tags" }) },
      proxyResponses: [
        () => json({ id: "doc_nt" }, 201),
        () => json({ results: [doc({ id: "doc_nt" })] }),
      ],
    });
    await handleItemEvent(built.ctx, itemEventMsg("mit_4"));
    expect(built.proxyCalls[0]?.body).not.toHaveProperty("tags");
  });

  it("deletes upstream when the item is trashed, and drops the mapping", async () => {
    const storage = createMemoryStorage();
    const seed = buildContext({
      storage,
      proxyResponses: [() => json({ nextPageCursor: null, results: [doc()] })],
    });
    await handleSchedule(seed.ctx, SCHEDULE_MSG());

    const built = buildContext({
      storage,
      items: { mit_1: marfaItem("mit_1", { title: "Gone" }, "trashed") },
      proxyResponses: [() => new Response(null, { status: 204 })],
    });
    await handleItemEvent(built.ctx, itemEventMsg("mit_1"));

    expect(built.proxyCalls[0]?.method).toBe("DELETE");
    const cursor = await readCursor(storage);
    expect(cursor.doc_mappings).not.toHaveProperty("doc_1");
  });

  it("treats a delete of an already-gone document as done", async () => {
    const storage = createMemoryStorage();
    const seed = buildContext({
      storage,
      proxyResponses: [() => json({ nextPageCursor: null, results: [doc()] })],
    });
    await handleSchedule(seed.ctx, SCHEDULE_MSG());

    const built = buildContext({
      storage,
      items: { mit_1: marfaItem("mit_1", { title: "Gone" }, "trashed") },
      proxyResponses: [() => json({ detail: "Not found." }, 404)],
    });
    const result = await handleItemEvent(built.ctx, itemEventMsg("mit_1"));
    expect(result).toEqual({ ok: true });
    const cursor = await readCursor(storage);
    expect(cursor.doc_mappings).not.toHaveProperty("doc_1");
  });

  it("recreates a document that was deleted upstream since the mapping was recorded", async () => {
    // Reader's deletes are permanent, so a 404 on update means the
    // mapping points at nothing and re-saving mints a fresh document.
    const storage = createMemoryStorage();
    const seed = buildContext({
      storage,
      proxyResponses: [() => json({ nextPageCursor: null, results: [doc()] })],
    });
    await handleSchedule(seed.ctx, SCHEDULE_MSG());

    const built = buildContext({
      storage,
      items: { mit_1: marfaItem("mit_1", { title: "Still here" }) },
      proxyResponses: [
        () => json({ detail: "Not found." }, 404),
        () => json({ id: "doc_replacement" }, 201),
        () => json({ results: [doc({ id: "doc_replacement" })] }),
      ],
    });
    await handleItemEvent(built.ctx, itemEventMsg("mit_1"));

    expect(built.proxyCalls[0]?.method).toBe("PATCH");
    expect(built.proxyCalls[1]?.method).toBe("POST");
    const cursor = await readCursor(storage);
    expect(cursor.doc_mappings).not.toHaveProperty("doc_1");
    expect(cursor.doc_mappings.doc_replacement).toBe("mit_1");
  });

  it("deletes upstream when the Marfa item has vanished entirely", async () => {
    const storage = createMemoryStorage();
    const seed = buildContext({
      storage,
      proxyResponses: [() => json({ nextPageCursor: null, results: [doc()] })],
    });
    await handleSchedule(seed.ctx, SCHEDULE_MSG());

    const built = buildContext({
      storage,
      items: { mit_1: null },
      proxyResponses: [() => new Response(null, { status: 204 })],
    });
    await handleItemEvent(built.ctx, itemEventMsg("mit_1"));
    expect(built.proxyCalls[0]?.method).toBe("DELETE");
  });

  it("applies a second edit inside the lag window instead of deferring it", async () => {
    // Deferring here loses the edit. The window is ten minutes, the
    // queue allows six retries, and the retries run out first — measured
    // against a live account, a trash issued shortly after a create was
    // still not applied twenty minutes later. The lag window guards
    // reactive reads, not outbound writes.
    const storage = createMemoryStorage();
    const seed = buildContext({
      storage,
      proxyResponses: [() => json({ nextPageCursor: null, results: [doc()] })],
    });
    await handleSchedule(seed.ctx, SCHEDULE_MSG());

    const built = buildContext({
      storage,
      items: { mit_1: marfaItem("mit_1", { title: "Edited again, quickly" }) },
      proxyResponses: [
        () => json({ id: "doc_1", url: "https://read.readwise.io/read/doc_1" }),
        () => json({ results: [doc({ title: "Edited again, quickly" })] }),
      ],
    });
    await built.ctx.echo.trackOutboundWrite("doc_1", "somehash");

    const result = await handleItemEvent(built.ctx, itemEventMsg("mit_1"));
    expect(result).toEqual({ ok: true });
    expect(built.proxyCalls[0]?.method).toBe("PATCH");
    expect((built.proxyCalls[0]?.body as { title?: string }).title).toBe(
      "Edited again, quickly",
    );
  });

  it("applies a trash inside the lag window, because a dropped delete is unrecoverable", async () => {
    const storage = createMemoryStorage();
    const seed = buildContext({
      storage,
      proxyResponses: [() => json({ nextPageCursor: null, results: [doc()] })],
    });
    await handleSchedule(seed.ctx, SCHEDULE_MSG());

    const built = buildContext({
      storage,
      items: { mit_1: marfaItem("mit_1", { title: "Gone" }, "trashed") },
      proxyResponses: [() => new Response(null, { status: 204 })],
    });
    await built.ctx.echo.trackOutboundWrite("doc_1", "somehash");

    const result = await handleItemEvent(built.ctx, itemEventMsg("mit_1"));
    expect(result).toEqual({ ok: true });
    expect(built.proxyCalls[0]?.method).toBe("DELETE");
    const cursor = await readCursor(storage);
    expect(cursor.doc_mappings).not.toHaveProperty("doc_1");
  });

  it("retries a server error", async () => {
    const built = buildContext({
      items: { mit_5: marfaItem("mit_5", { title: "5xx" }) },
      proxyResponses: [() => new Response("boom", { status: 502 })],
    });
    const result = await handleItemEvent(built.ctx, itemEventMsg("mit_5"));
    expect(result).toMatchObject({ ok: false, retry: true });
  });

  it("acks a client error and raises it for the operator", async () => {
    const built = buildContext({
      items: { mit_6: marfaItem("mit_6", { title: "4xx" }) },
      proxyResponses: [() => json({ detail: "Bad request" }, 400)],
    });
    const result = await handleItemEvent(built.ctx, itemEventMsg("mit_6"));
    expect(result).toEqual({ ok: true });
    expect(built.emitted.at(-1)?.properties?.severity).toBe("action_required");
  });

  it("ignores an event this connection caused", async () => {
    const built = buildContext({
      items: { mit_1: marfaItem("mit_1", { title: "Self" }) },
      proxyResponses: [],
    });
    const result = await handleItemEvent(
      built.ctx,
      itemEventMsg("mit_1", CONNECTION_ID),
    );
    expect(result).toEqual({ ok: true });
    expect(built.proxyCalls).toHaveLength(0);
  });

  it("ignores an event for a type it does not own", async () => {
    // The bridge filters to the manifest's target types upstream; this
    // pins the handler's own defensive check for anything bypassing it.
    const built = buildContext({
      items: {
        mit_8: {
          id: "mit_8",
          type: "core.bookmark",
          state: "active",
          properties: { title: "A bookmark" },
        } as unknown as ItemResource,
      },
      proxyResponses: [],
    });
    const result = await handleItemEvent(built.ctx, itemEventMsg("mit_8"));
    expect(result).toEqual({ ok: true });
    expect(built.proxyCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("tag normalization", () => {
  it("accepts the dictionary shape reads return", () => {
    expect(
      __internals.normalizeTags({
        b: { name: "b", type: "public_api", created: 1 },
        a: { name: "a", type: "public_api", created: 2 },
      }),
    ).toEqual(["a", "b"]);
  });

  it("accepts the list shape writes take", () => {
    expect(__internals.normalizeTags(["z", "a"])).toEqual(["a", "z"]);
  });

  it("treats absent tags as none, in both shapes real data uses", () => {
    expect(__internals.normalizeTags(null)).toEqual([]);
    expect(__internals.normalizeTags({})).toEqual([]);
    expect(__internals.normalizeTags(undefined)).toEqual([]);
  });

  it("sorts and deduplicates, so the hash does not move on key order alone", () => {
    expect(__internals.normalizeTags(["b", "a", "b"])).toEqual(["a", "b"]);
  });
});

describe("content hash", () => {
  it("changes when a mirrored field changes", async () => {
    const a = await __internals.contentHashForDocument(doc() as never);
    const b = await __internals.contentHashForDocument(
      doc({ title: "Different" }) as never,
    );
    expect(a).not.toBe(b);
  });

  it("holds steady across fields a round-trip does not carry", async () => {
    const a = await __internals.contentHashForDocument(doc() as never);
    const b = await __internals.contentHashForDocument(
      doc({
        reading_progress: 0.9,
        last_opened_at: "2026-08-09T00:00:00Z",
      }) as never,
    );
    expect(a).toBe(b);
  });

  it("agrees across the two tag shapes for the same tags", async () => {
    const fromRead = await __internals.contentHashForDocument(
      doc({ tags: { a: { name: "a" }, b: { name: "b" } } }) as never,
    );
    const fromList = await __internals.contentHashForDocument(
      doc({ tags: ["b", "a"] }) as never,
    );
    expect(fromRead).toBe(fromList);
  });
});
