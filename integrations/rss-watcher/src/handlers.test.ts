/**
 * Handler-level tests for the RSS Watcher integration.
 *
 * Builds ConnectionContext inline (the template's pattern) so the
 * Marfa HTTP API doesn't need to be reachable. The integration's
 * outbound fetch (against the feed URL) is injected via
 * `createScheduleHandler({ fetch })` so no globalThis stubbing is
 * needed.
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
  type ScheduleMessage,
  familyOnlyMappingResolver,
} from "@withmarfa/runtime-sdk";
import {
  createScheduleHandler,
  DEFAULT_FEED_URL,
  RECENT_ID_RING_SIZE,
} from "./handlers.js";

interface InMemoryStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

function createMemoryStorage(): InMemoryStorage {
  const data = new Map<string, unknown>();
  return {
    get(key) {
      return Promise.resolve(data.get(key));
    },
    put(key, value) {
      data.set(key, value);
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

interface BuildOptions {
  /** Connection record returned by ctx.marfa.getItem(connection_id).
   *  Set to `undefined` to simulate the connection record being
   *  unavailable (handler should fall back to DEFAULT_FEED_URL). */
  connectionRecord?: Partial<ItemResource>;
  /** Mutable holder so a test can change the configured feed URL
   *  between ticks, the way an operator would. Takes precedence over
   *  `connectionRecord` when set. */
  connectionRecordRef?: { current: Partial<ItemResource> | null };
  /** When set, ctx.marfa.getItem(connection_id) rejects with this. */
  connectionLookupError?: Error;
  /** When set, ctx.marfa.createItem rejects with this error for the
   *  first N calls before recovering. */
  createItemError?: { afterCalls?: number; error: Error };
}

interface BuiltContext {
  ctx: ConnectionContext;
  emitted: CapturedActivity[];
  created: CreateItemInput[];
}

function buildContext(opts: BuildOptions = {}): BuiltContext {
  const storage = createMemoryStorage();
  const emitted: CapturedActivity[] = [];
  const created: CreateItemInput[] = [];
  let createCallCount = 0;
  const connectionId = "conn_rss_test";

  const client = {
    createItem: (input: CreateItemInput) => {
      createCallCount += 1;
      if (
        opts.createItemError !== undefined &&
        createCallCount <= (opts.createItemError.afterCalls ?? 0) + 1
      ) {
        return Promise.reject(opts.createItemError.error);
      }
      if (input.type === "system.activity") {
        emitted.push({ type: input.type, properties: input.properties });
        return Promise.resolve({ id: "act_x", type: input.type });
      }
      created.push(input);
      return Promise.resolve({
        id: `itm_${String(created.length)}`,
        type: input.type,
      });
    },
    getItem: (id: string) => {
      if (id !== connectionId) return Promise.resolve(null);
      if (opts.connectionLookupError !== undefined) {
        return Promise.reject(opts.connectionLookupError);
      }
      if (opts.connectionRecordRef !== undefined) {
        return Promise.resolve(opts.connectionRecordRef.current);
      }
      return Promise.resolve(opts.connectionRecord ?? null);
    },
  } as unknown as ConnectionClient;

  const ctx: ConnectionContext = {
    connection_id: connectionId,
    integration_name: "withmarfa.rss-watcher",
    marfa: client,
    cursor: createCursorStore(storage),
    activity: createActivitySink(client, connectionId),
    echo: createEchoSuppression(storage, { echo_ttl_seconds: 60 }),
    mapping: familyOnlyMappingResolver(),
    cycle: null,
  };
  return { ctx, emitted, created };
}

const FEED_TWO = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Test Feed</title>
  <link rel="self" href="https://example.com/feed" />
  <id>https://example.com/feed</id>
  <entry>
    <id>entry-2</id>
    <title>Newer entry</title>
    <link rel="alternate" href="https://example.com/2" />
    <updated>2026-04-30T10:00:00Z</updated>
    <author><name>Author Two</name></author>
    <summary>Summary 2</summary>
  </entry>
  <entry>
    <id>entry-1</id>
    <title>Older entry</title>
    <link rel="alternate" href="https://example.com/1" />
    <updated>2026-04-29T10:00:00Z</updated>
    <author><name>Author One</name></author>
    <summary>Summary 1</summary>
  </entry>
</feed>`;

const FEED_THREE_NEWER_ENTRY = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Test Feed</title>
  <link rel="self" href="https://example.com/feed" />
  <id>https://example.com/feed</id>
  <entry>
    <id>entry-3</id>
    <title>Even newer</title>
    <link rel="alternate" href="https://example.com/3" />
    <updated>2026-05-01T08:00:00Z</updated>
    <summary>Brand new</summary>
  </entry>
  <entry>
    <id>entry-2</id>
    <title>Newer entry</title>
    <link rel="alternate" href="https://example.com/2" />
    <updated>2026-04-30T10:00:00Z</updated>
    <summary>Summary 2</summary>
  </entry>
</feed>`;

const RSS_TWO = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Example Newsroom</title>
    <link>https://example.com/</link>
    <item>
      <title>Newer story</title>
      <link>https://example.com/2</link>
      <pubDate>Thu, 30 Apr 2026 10:00:00 +0000</pubDate>
      <dc:creator>Ada Lovelace</dc:creator>
      <description>Second summary</description>
    </item>
    <item>
      <title>Older story</title>
      <link>https://example.com/1</link>
      <pubDate>Wed, 29 Apr 2026 10:00:00 +0000</pubDate>
      <description>First summary</description>
    </item>
  </channel>
</rss>`;

function makeFetch(
  responses: { url?: string; status?: number; body: string }[],
): typeof fetch {
  let call = 0;
  return (): Promise<Response> => {
    const r = responses[call] ?? responses[responses.length - 1]!;
    call += 1;
    return Promise.resolve(new Response(r.body, { status: r.status ?? 200 }));
  };
}

function urlToString(url: RequestInfo | URL): string {
  if (typeof url === "string") return url;
  if (url instanceof URL) return url.href;
  return url.url;
}

const SCHEDULE_MSG = (ms: number): ScheduleMessage => ({
  kind: "schedule",
  integration_name: "withmarfa.rss-watcher",
  connection_id: "conn_rss_test",
  scheduled_for_ms: ms,
});

describe("RSS Watcher schedule handler", () => {
  it("first run creates one bookmark per entry and advances the cursor", async () => {
    const { ctx, emitted, created } = buildContext();
    const handler = createScheduleHandler({
      fetch: makeFetch([{ body: FEED_TWO }]),
    });

    const result = await handler(ctx, SCHEDULE_MSG(1_700_000_000_000));

    expect(result).toEqual({ ok: true });
    expect(created).toHaveLength(2);
    // Oldest first into the ring (matches reverse-iteration in handler)
    expect(created[0]!.properties).toMatchObject({
      title: "Older entry",
      url: "https://example.com/1",
    });
    expect(created[1]!.properties).toMatchObject({
      title: "Newer entry",
      url: "https://example.com/2",
    });
    expect(created[0]!.properties).toMatchObject({
      source_title: "Test Feed",
      source_url: "https://example.com/feed",
      author: "Author One",
    });
    // Every bookmark stamps the upstream entry id as source_id so
    // POST /items can short-circuit a whole-batch retry to update
    // rather than create a duplicate.
    expect(created[0]!.source_id).toBe("entry-1");
    expect(created[1]!.source_id).toBe("entry-2");

    const cursor = (await ctx.cursor.read("main")) as {
      feed_url: string;
      last_seen_updated: string;
      recent_entry_ids: string[];
    };
    expect(cursor.feed_url).toBe(DEFAULT_FEED_URL);
    expect(cursor.recent_entry_ids).toEqual(["entry-1", "entry-2"]);
    expect(cursor.last_seen_updated).toBe("2026-04-30T10:00:00Z");
    // One info activity at the end summarizing the run.
    const summaries = emitted.map((e) => e.properties?.summary);
    expect(summaries).toContain("RSS Watcher created 2 bookmark(s)");
  });

  it("second run on an unchanged feed creates no new bookmarks", async () => {
    const { ctx, created, emitted } = buildContext();
    const handler = createScheduleHandler({
      fetch: makeFetch([{ body: FEED_TWO }, { body: FEED_TWO }]),
    });

    await handler(ctx, SCHEDULE_MSG(1_700_000_000_000));
    expect(created).toHaveLength(2);
    await handler(ctx, SCHEDULE_MSG(1_700_000_300_000));
    expect(created).toHaveLength(2); // no change

    const noNewSummaries = emitted
      .map((e) => e.properties?.summary)
      .filter((s) => s === "RSS Watcher tick — no new entries");
    expect(noNewSummaries).toHaveLength(1);
  });

  it("creates only the new entry on the second run when the feed grows", async () => {
    const { ctx, created } = buildContext();
    const handler = createScheduleHandler({
      fetch: makeFetch([{ body: FEED_TWO }, { body: FEED_THREE_NEWER_ENTRY }]),
    });

    await handler(ctx, SCHEDULE_MSG(1_700_000_000_000));
    expect(created).toHaveLength(2);
    await handler(ctx, SCHEDULE_MSG(1_700_000_300_000));
    expect(created).toHaveLength(3);
    expect(created[2]!.properties).toMatchObject({
      title: "Even newer",
      url: "https://example.com/3",
    });
  });

  it("uses the configured feed_url from the connection record when present", async () => {
    const customUrl = "https://example.com/custom-feed";
    const { ctx } = buildContext({
      connectionRecord: {
        properties: { configuration: { feed_url: customUrl } },
      },
    });
    let requestedUrl: string | null = null;
    const handler = createScheduleHandler({
      fetch: (url: RequestInfo | URL) => {
        requestedUrl = urlToString(url);
        return Promise.resolve(new Response(FEED_TWO, { status: 200 }));
      },
    });

    await handler(ctx, SCHEDULE_MSG(1_700_000_000_000));
    expect(requestedUrl).toBe(customUrl);

    const cursor = (await ctx.cursor.read("main")) as { feed_url: string };
    expect(cursor.feed_url).toBe(customUrl);
  });

  it("falls back to the default feed_url when no configuration is set", async () => {
    const { ctx } = buildContext();
    let requestedUrl: string | null = null;
    const handler = createScheduleHandler({
      fetch: (url: RequestInfo | URL) => {
        requestedUrl = urlToString(url);
        return Promise.resolve(new Response(FEED_TWO, { status: 200 }));
      },
    });

    await handler(ctx, SCHEDULE_MSG(1_700_000_000_000));
    expect(requestedUrl).toBe(DEFAULT_FEED_URL);
  });

  it("switches feeds when the configured feed_url changes", async () => {
    // The connection is reconfigured between ticks. Caching the URL on
    // the cursor and never re-reading it meant the change was silently
    // ignored: the integration kept polling the old feed forever.
    const ref = {
      current: {
        properties: { configuration: { feed_url: "https://example.com/a" } },
      } as Partial<ItemResource>,
    };
    const { ctx, created, emitted } = buildContext({
      connectionRecordRef: ref,
    });
    const requested: string[] = [];
    const handler = createScheduleHandler({
      fetch: (url: RequestInfo | URL) => {
        requested.push(urlToString(url));
        return Promise.resolve(
          new Response(
            requested.length === 1 ? FEED_TWO : FEED_THREE_NEWER_ENTRY,
            { status: 200 },
          ),
        );
      },
    });

    await handler(ctx, SCHEDULE_MSG(1_700_000_000_000));
    expect(created).toHaveLength(2);

    ref.current = {
      properties: { configuration: { feed_url: "https://example.com/b" } },
    };
    await handler(ctx, SCHEDULE_MSG(1_700_000_300_000));

    expect(requested).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
    const cursor = (await ctx.cursor.read("main")) as { feed_url: string };
    expect(cursor.feed_url).toBe("https://example.com/b");
    expect(
      emitted.some((e) =>
        ((e.properties?.summary as string | undefined) ?? "").includes(
          "feed URL changed",
        ),
      ),
    ).toBe(true);
  });

  it("resets dedupe state on a feed switch so the new feed is not suppressed", async () => {
    // entry-2's `updated` is older than the watermark the first feed
    // left behind. Carrying the watermark across a feed switch would
    // filter it out and the new feed's back catalog would never appear.
    const ref = {
      current: {
        properties: { configuration: { feed_url: "https://example.com/a" } },
      } as Partial<ItemResource>,
    };
    const { ctx, created } = buildContext({ connectionRecordRef: ref });
    const handler = createScheduleHandler({
      fetch: makeFetch([{ body: FEED_THREE_NEWER_ENTRY }, { body: FEED_TWO }]),
    });

    await handler(ctx, SCHEDULE_MSG(1_700_000_000_000));
    expect(created).toHaveLength(2);

    ref.current = {
      properties: { configuration: { feed_url: "https://example.com/b" } },
    };
    await handler(ctx, SCHEDULE_MSG(1_700_000_300_000));
    expect(created).toHaveLength(4);
    expect(
      created.map((c) => (c.properties as { title?: string }).title),
    ).toEqual(["Newer entry", "Even newer", "Older entry", "Newer entry"]);
  });

  it("keeps polling the same feed when the configuration is unchanged", async () => {
    const { ctx, emitted } = buildContext({
      connectionRecord: {
        properties: { configuration: { feed_url: "https://example.com/a" } },
      },
    });
    const handler = createScheduleHandler({
      fetch: makeFetch([{ body: FEED_TWO }, { body: FEED_TWO }]),
    });

    await handler(ctx, SCHEDULE_MSG(1_700_000_000_000));
    await handler(ctx, SCHEDULE_MSG(1_700_000_300_000));

    expect(
      emitted.filter((e) =>
        ((e.properties?.summary as string | undefined) ?? "").includes(
          "feed URL changed",
        ),
      ),
    ).toHaveLength(0);
  });

  it("fails the tick when the configuration read itself fails", async () => {
    // Resolving a failed read to the default URL would look identical to
    // a deliberate switch away from a configured feed, wiping the dedupe
    // state and replaying the whole feed as new bookmarks.
    const { ctx, created, emitted } = buildContext({
      connectionLookupError: new Error("storage unavailable"),
    });
    let fetched = false;
    const handler = createScheduleHandler({
      fetch: () => {
        fetched = true;
        return Promise.resolve(new Response(FEED_TWO, { status: 200 }));
      },
    });

    const result = await handler(ctx, SCHEDULE_MSG(1_700_000_000_000));
    expect(result).toMatchObject({ ok: false, retry: true });
    expect(fetched).toBe(false);
    expect(created).toHaveLength(0);
    expect(emitted[0]!.properties?.summary).toMatch(
      /connection configuration lookup failed/,
    );
  });

  it("emits action_required and retries on fetch error", async () => {
    const { ctx, emitted, created } = buildContext();
    const handler = createScheduleHandler({
      fetch: (() =>
        Promise.reject(new Error("boom"))) as unknown as typeof fetch,
    });

    const result = await handler(ctx, SCHEDULE_MSG(1_700_000_000_000));
    expect(result).toEqual({
      ok: false,
      retry: true,
      reason: "fetch failed",
    });
    expect(created).toHaveLength(0);
    const required = emitted.filter(
      (e) => e.properties?.severity === "action_required",
    );
    expect(required).toHaveLength(1);
    expect(required[0]!.properties?.summary).toMatch(/fetch failed/);
  });

  it("emits action_required and retries on non-2xx response", async () => {
    const { ctx, emitted } = buildContext();
    const handler = createScheduleHandler({
      fetch: makeFetch([{ status: 503, body: "" }]),
    });

    const result = await handler(ctx, SCHEDULE_MSG(1_700_000_000_000));
    expect(result.ok).toBe(false);
    expect(emitted[0]!.properties?.summary).toMatch(/feed responded 503/);
  });

  it("emits action_required and retries on parse error", async () => {
    const { ctx, emitted } = buildContext();
    const handler = createScheduleHandler({
      fetch: makeFetch([{ body: "<html><body>Not a feed</body></html>" }]),
    });

    const result = await handler(ctx, SCHEDULE_MSG(1_700_000_000_000));
    expect(result.ok).toBe(false);
    expect(emitted[0]!.properties?.summary).toMatch(/feed parse failed/);
  });

  it("creates bookmarks from an RSS 2.0 feed", async () => {
    const { ctx, created } = buildContext();
    const handler = createScheduleHandler({
      fetch: makeFetch([{ body: RSS_TWO }]),
    });

    const result = await handler(ctx, SCHEDULE_MSG(1_700_000_000_000));
    expect(result).toEqual({ ok: true });
    expect(created).toHaveLength(2);
    // Oldest first, same ordering contract as the Atom path.
    expect(created[0]!.properties).toMatchObject({
      title: "Older story",
      url: "https://example.com/1",
      source_title: "Example Newsroom",
    });
    expect(created[0]!.source_id).toBe("https://example.com/1");
    expect(created[1]!.properties).toMatchObject({
      title: "Newer story",
      author: "Ada Lovelace",
      published_at: "2026-04-30T10:00:00.000Z",
    });

    const cursor = (await ctx.cursor.read("main")) as {
      last_seen_updated: string;
    };
    expect(cursor.last_seen_updated).toBe("2026-04-30T10:00:00.000Z");
  });

  it("continues past per-entry createItem failures and reports each", async () => {
    // First createItem (the older entry) fails; the second (newer) succeeds.
    // The summary activity at the end still fires.
    const { ctx, emitted, created } = buildContext({
      createItemError: { afterCalls: 0, error: new Error("server 500") },
    });
    const handler = createScheduleHandler({
      fetch: makeFetch([{ body: FEED_TWO }]),
    });

    const result = await handler(ctx, SCHEDULE_MSG(1_700_000_000_000));
    expect(result).toEqual({ ok: true });
    expect(created).toHaveLength(1); // second entry succeeded
    const required = emitted.filter(
      (e) => e.properties?.severity === "action_required",
    );
    expect(required).toHaveLength(1);
    expect(required[0]!.properties?.summary).toMatch(
      /failed to create bookmark/,
    );
  });

  it("recent_entry_ids ring stays bounded at RECENT_ID_RING_SIZE", async () => {
    // Pre-seed cursor with RING_SIZE entries; another tick adds two
    // and we expect the oldest two to be evicted.
    const { ctx } = buildContext();
    const seeded = Array.from(
      { length: RECENT_ID_RING_SIZE },
      (_, i) => `seed-${String(i)}`,
    );
    await ctx.cursor.write("main", {
      feed_url: DEFAULT_FEED_URL,
      last_seen_updated: "2025-01-01T00:00:00Z",
      recent_entry_ids: seeded,
      last_run_at: "2025-01-01T00:00:00Z",
    });

    const handler = createScheduleHandler({
      fetch: makeFetch([{ body: FEED_TWO }]),
    });
    await handler(ctx, SCHEDULE_MSG(1_700_000_000_000));

    const cursor = (await ctx.cursor.read("main")) as {
      recent_entry_ids: string[];
    };
    expect(cursor.recent_entry_ids).toHaveLength(RECENT_ID_RING_SIZE);
    // Oldest two seeds evicted; newest two are entry-1, entry-2.
    expect(cursor.recent_entry_ids.includes("seed-0")).toBe(false);
    expect(cursor.recent_entry_ids.includes("seed-1")).toBe(false);
    expect(cursor.recent_entry_ids.slice(-2)).toEqual(["entry-1", "entry-2"]);
  });
});
