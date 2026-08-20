import { familyOnlyMappingResolver } from "@withmarfa/runtime-sdk";
/* eslint-disable @typescript-eslint/require-await --
   The harness stubs stand in for asynchronous SDK methods, so they are
   async to match the interface they replace rather than because their
   bodies await anything. */
import { describe, expect, it } from "vitest";
import { createScheduleHandler } from "./handlers.js";
import { EPISODE_BATCH_SIZE, MAX_EPISODES_PER_TICK } from "./manifest.js";
import type { ConnectionContext } from "@withmarfa/runtime-sdk";

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

interface EdgeCall {
  source_id: string;
  target_id: string;
  edge_type: string;
}

interface BulkCall {
  inputs: {
    type: string;
    source_id?: string;
    properties?: Record<string, unknown>;
    edges?: unknown;
  }[];
}

interface HarnessOptions {
  feedUrls?: string[];
  writeFamily?: "podcast" | "core";
  /** Responses keyed by URL; each call shifts the next one off. */
  responses?: Record<string, (Response | Error)[]>;
  /** Return "errored" for source_ids matching this. */
  failEpisode?: (sourceId: string) => boolean;
  /** Throw from bulkUpsertItems on the nth call (1-based). */
  throwOnBulkCall?: number;
  ensureEdgeThrows?: boolean;
  configReadThrows?: boolean;
  cursors?: Record<string, unknown>;
}

function harness(opts: HarnessOptions = {}) {
  // structuredClone on both sides, so a handler cannot mutate stored state
  // by reference and make a later assertion pass for the wrong reason.
  const store = new Map<string, unknown>();
  for (const [k, v] of Object.entries(opts.cursors ?? {}))
    store.set(k, structuredClone(v));

  const cursorWrites: { key: string; value: Record<string, unknown> }[] = [];
  const activity: {
    severity: string;
    summary: string;
    detail?: Record<string, unknown>;
  }[] = [];
  const bulkCalls: BulkCall[] = [];
  const edges: EdgeCall[] = [];
  const created: {
    type: string;
    source_id?: string;
    properties?: Record<string, unknown>;
  }[] = [];
  const fetched: { url: string; headers: Record<string, string> }[] = [];

  let itemSeq = 0;
  let bulkSeq = 0;

  const marfa = {
    async getItem(id: string) {
      if (opts.configReadThrows === true)
        throw new Error("connection lookup failed");
      return {
        id,
        type: "system.connection",
        properties: {
          configuration: {
            feed_urls: opts.feedUrls ?? ["https://feeds.example/show"],
            write_family: opts.writeFamily ?? "podcast",
          },
        },
      };
    },
    async createItem(input: {
      type: string;
      source_id?: string;
      properties?: Record<string, unknown>;
    }) {
      created.push(input);
      itemSeq += 1;
      return { id: `item-${String(itemSeq)}` };
    },
    async bulkUpsertItems(inputs: BulkCall["inputs"]) {
      bulkSeq += 1;
      if (opts.throwOnBulkCall === bulkSeq)
        throw new Error("bulk write failed");
      bulkCalls.push({ inputs });
      return {
        counts: { created: inputs.length, updated: 0, skipped: 0, errored: 0 },
        results: inputs.map((input, index) => {
          if (opts.failEpisode?.(input.source_id ?? "") === true) {
            return {
              index,
              outcome: "errored" as const,
              error: { code: "x", message: "refused" },
            };
          }
          itemSeq += 1;
          return {
            index,
            outcome: "created" as const,
            id: `item-${String(itemSeq)}`,
          };
        }),
      };
    },
    async ensureEdge(input: EdgeCall) {
      if (opts.ensureEdgeThrows === true) throw new Error("edge refused");
      edges.push(input);
      return "created" as const;
    },
  };

  const ctx = {
    connection_id: "conn-1",
    integration_name: "withmarfa.podcasts",
    marfa,
    cursor: {
      async read(key: string) {
        const v = store.get(key);
        return v === undefined ? null : structuredClone(v);
      },
      async write(key: string, value: unknown) {
        store.set(key, structuredClone(value));
        cursorWrites.push({
          key,
          value: structuredClone(value) as Record<string, unknown>,
        });
      },
    },
    activity: {
      async emit(a: {
        severity: string;
        summary: string;
        detail?: Record<string, unknown>;
      }) {
        activity.push(a);
      },
    },
    echo: {} as never,
    mapping: familyOnlyMappingResolver(),
    cycle: null,
  } as unknown as ConnectionContext;

  const fetchImpl = (async (
    url: string,
    init?: { headers?: Record<string, string> },
  ) => {
    fetched.push({ url, headers: init?.headers ?? {} });
    const queue = opts.responses?.[url];
    const next = queue?.shift();
    if (next instanceof Error) throw next;
    return next ?? feedResponse(feedXml(3));
  }) as unknown as typeof fetch;

  return {
    ctx,
    store,
    cursorWrites,
    activity,
    bulkCalls,
    edges,
    created,
    fetched,
    fetchImpl,
  };
}

function feedResponse(
  body: string,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  return new Response(init.status === 304 ? null : body, {
    status: init.status ?? 200,
    headers: init.headers ?? {},
  });
}

function feedXml(episodes: number, guidPrefix = "ep"): string {
  const items = Array.from({ length: episodes }, (_, i) => {
    const n = episodes - i; // newest first, as feeds are written
    return `<item><title>Episode ${String(n)}</title><guid isPermaLink="false">${guidPrefix}-${String(n)}</guid>
      <pubDate>Mon, 0${String((n % 9) + 1)} Jan 2024 00:00:00 +0000</pubDate>
      <enclosure url="https://cdn.example/${guidPrefix}-${String(n)}.mp3" type="audio/mpeg" length="1"/>
      <itunes:duration>600</itunes:duration></item>`;
  }).join("\n");
  return `<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0">
  <channel><title>A Show</title><link>https://example.com</link>
  <podcast:guid>11111111-2222-5333-8444-555555555555</podcast:guid>
  ${items}</channel></rss>`;
}

const MSG = { scheduled_for_ms: Date.parse("2026-08-18T12:00:00.000Z") };

function feedCursors(
  writes: { key: string; value: Record<string, unknown> }[],
) {
  return writes.filter((w) => w.key.startsWith("feed:"));
}

/* ------------------------------------------------------------------ */
/* Durability — the four that the previous integration's bug required   */
/* ------------------------------------------------------------------ */

describe("progress is recorded as it happens", () => {
  it("writes the cursor after every batch, not once at the end", async () => {
    // The failure this guards against passed a "cursor is correct at the
    // end" test perfectly: it was correct at the end, and empty every time
    // a sweep died before reaching it.
    const episodes = EPISODE_BATCH_SIZE * 3;
    const h = harness({
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(episodes))],
      },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    const checkpoints = feedCursors(h.cursorWrites).filter(
      (w) => "backfill_cursor" in w.value,
    );
    expect(checkpoints.length).toBeGreaterThanOrEqual(3);
    expect(h.bulkCalls).toHaveLength(3);
  });

  it("leaves completed batches recorded when a sweep dies mid-drain", async () => {
    const episodes = EPISODE_BATCH_SIZE * 3;
    const h = harness({
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(episodes))],
      },
      throwOnBulkCall: 2,
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    const feedKey = [...h.store.keys()].find((k) => k.startsWith("feed:"));
    const stored = h.store.get(String(feedKey)) as {
      backfill_cursor: number | null;
    };
    // The first batch applied and is not repeated; the second did not and is.
    expect(stored.backfill_cursor).toBe(EPISODE_BATCH_SIZE);
    expect(h.bulkCalls).toHaveLength(1);
  });

  it("resumes from where it stopped rather than starting the feed again", async () => {
    const episodes = EPISODE_BATCH_SIZE * 2;
    const first = harness({
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(episodes))],
      },
      throwOnBulkCall: 2,
    });
    await createScheduleHandler({ fetch: first.fetchImpl })(first.ctx, MSG);

    const carried: Record<string, unknown> = {};
    for (const [k, v] of first.store) carried[k] = v;

    const second = harness({
      cursors: carried,
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(episodes))],
      },
    });
    await createScheduleHandler({ fetch: second.fetchImpl })(second.ctx, MSG);

    // Nothing from the first batch is offered again.
    const written = second.bulkCalls.flatMap((c) =>
      c.inputs.map((i) => i.source_id),
    );
    expect(written.some((s) => String(s).endsWith("g:ep-1"))).toBe(false);
    expect(written.length).toBe(EPISODE_BATCH_SIZE);
  });

  it("holds the watermark for a refused episode, then releases it after a retry", async () => {
    const feed = feedXml(2);
    const h = harness({
      responses: {
        "https://feeds.example/show": [feedResponse(feed), feedResponse(feed)],
      },
      failEpisode: (s) => s.endsWith("g:ep-2"),
    });
    const handler = createScheduleHandler({ fetch: h.fetchImpl });

    await handler(h.ctx, MSG);
    const feedKey = String(
      [...h.store.keys()].find((k) => k.startsWith("feed:")),
    );
    const afterFirst = h.store.get(feedKey) as {
      retried_after_failure: boolean;
      last_seen_published: string | null;
    };
    expect(afterFirst.retried_after_failure).toBe(true);
    expect(afterFirst.last_seen_published).toBeNull();

    await handler(h.ctx, MSG);
    const afterSecond = h.store.get(feedKey) as {
      retried_after_failure: boolean;
      last_seen_published: string | null;
    };
    // Held forever, one bad episode makes every tick re-walk the catalogue.
    expect(afterSecond.retried_after_failure).toBe(false);
    expect(afterSecond.last_seen_published).not.toBeNull();
  });

  it("parks rather than exceeding its episode budget in one tick", async () => {
    const h = harness({
      responses: {
        "https://feeds.example/show": [
          feedResponse(feedXml(MAX_EPISODES_PER_TICK + 40)),
        ],
      },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    const feedKey = String(
      [...h.store.keys()].find((k) => k.startsWith("feed:")),
    );
    const stored = h.store.get(feedKey) as {
      backfill_cursor: number | null;
      last_seen_published: string | null;
    };
    expect(stored.backfill_cursor).not.toBeNull();
    // A parked feed has not finished, so its watermark must not move.
    expect(stored.last_seen_published).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* The containment edge                                                */
/* ------------------------------------------------------------------ */

describe("episodes are joined to their show", () => {
  it("writes the edge from the episode to the show", async () => {
    const h = harness({
      responses: { "https://feeds.example/show": [feedResponse(feedXml(2))] },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    expect(h.edges).toHaveLength(2);
    for (const edge of h.edges) {
      // Asserted by name, not position: a swap is the mistake this catches,
      // and the two arguments are the same shape.
      expect(edge.edge_type).toBe("in-collection");
      expect(edge.target_id).toBe("item-1"); // the show, written first
      expect(edge.source_id).not.toBe("item-1");
    }
  });

  it("never sends inline edges on the batch write", async () => {
    // Inline edges replace rather than append, per edge type, so a sweep
    // would silently delete any collection a person had added an episode
    // to. This is the test that stops that becoming an optimization.
    const h = harness({
      responses: { "https://feeds.example/show": [feedResponse(feedXml(3))] },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    for (const call of h.bulkCalls) {
      for (const input of call.inputs) expect(input.edges).toBeUndefined();
    }
  });

  it("writes the show before any episode", async () => {
    const h = harness({
      responses: { "https://feeds.example/show": [feedResponse(feedXml(2))] },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    expect(h.created[0]?.type).toBe("withmarfa.podcast.show");
    expect(h.bulkCalls[0]?.inputs[0]?.type).toBe("withmarfa.podcast.episode");
  });

  it("reports an edge refusal instead of swallowing it", async () => {
    const h = harness({
      responses: { "https://feeds.example/show": [feedResponse(feedXml(1))] },
      ensureEdgeThrows: true,
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    expect(
      h.activity.some(
        (a) =>
          a.severity === "action_required" &&
          a.summary.includes("not joined to its show"),
      ),
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Conditional requests                                                */
/* ------------------------------------------------------------------ */

describe("a feed that has not changed", () => {
  it("sends both revalidators, echoing a weak tag verbatim", async () => {
    const feed = feedXml(1);
    const h = harness({
      responses: {
        "https://feeds.example/show": [
          feedResponse(feed, {
            headers: {
              etag: 'W/"abc"',
              "last-modified": "Mon, 01 Jan 2024 00:00:00 GMT",
            },
          }),
          feedResponse("", { status: 304 }),
        ],
      },
    });
    const handler = createScheduleHandler({ fetch: h.fetchImpl });
    await handler(h.ctx, MSG);
    await handler(h.ctx, MSG);

    const second = h.fetched[1]?.headers ?? {};
    expect(second["If-None-Match"]).toBe('W/"abc"');
    expect(second["If-Modified-Since"]).toBe("Mon, 01 Jan 2024 00:00:00 GMT");
  });

  it("does no work at all on a 304", async () => {
    const h = harness({
      responses: {
        "https://feeds.example/show": [
          feedResponse(feedXml(1), { headers: { etag: '"v1"' } }),
          feedResponse("", { status: 304 }),
        ],
      },
    });
    const handler = createScheduleHandler({ fetch: h.fetchImpl });
    await handler(h.ctx, MSG);
    const bulkAfterFirst = h.bulkCalls.length;
    await handler(h.ctx, MSG);

    expect(h.bulkCalls).toHaveLength(bulkAfterFirst);
    expect(
      h.created.filter((c) => c.type === "withmarfa.podcast.show"),
    ).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

describe("configuration", () => {
  it("aborts the tick when the configuration cannot be read", async () => {
    // An empty list and a failed read are indistinguishable downstream, and
    // an empty list reads as "unsubscribed from everything".
    const h = harness({ configReadThrows: true });
    const result = await createScheduleHandler({ fetch: h.fetchImpl })(
      h.ctx,
      MSG,
    );

    expect(result).toEqual(expect.objectContaining({ ok: false, retry: true }));
    expect(h.cursorWrites).toHaveLength(0);
    expect(h.fetched).toHaveLength(0);
  });

  it("retires a removed feed rather than forgetting it", async () => {
    const first = harness({
      feedUrls: ["https://feeds.example/a", "https://feeds.example/b"],
      responses: {
        "https://feeds.example/a": [feedResponse(feedXml(1, "a"))],
        "https://feeds.example/b": [feedResponse(feedXml(1, "b"))],
      },
    });
    await createScheduleHandler({ fetch: first.fetchImpl })(first.ctx, MSG);

    const carried: Record<string, unknown> = {};
    for (const [k, v] of first.store) carried[k] = v;

    const second = harness({
      cursors: carried,
      feedUrls: ["https://feeds.example/a"],
      responses: {
        "https://feeds.example/a": [feedResponse("", { status: 304 })],
      },
    });
    await createScheduleHandler({ fetch: second.fetchImpl })(second.ctx, MSG);

    const retired = [...second.store.values()].filter(
      (v) => (v as { retired_at?: string | null }).retired_at != null,
    );
    expect(retired).toHaveLength(1);
    // Kept, not deleted: re-adding must not replay the back catalogue.
    expect(retired[0]).toHaveProperty("recent_entry_ids");
  });

  it("writes the core family when a connection asks for it", async () => {
    const h = harness({
      writeFamily: "core",
      responses: { "https://feeds.example/show": [feedResponse(feedXml(1))] },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    expect(h.created[0]?.type).toBe("core.media.series");
    expect(h.bulkCalls[0]?.inputs[0]?.type).toBe("core.media.episode");
    const props = h.bulkCalls[0]?.inputs[0]?.properties ?? {};
    expect(props.media_url).toBe("https://cdn.example/ep-1.mp3");
    expect(props.mime_type).toBe("audio/mpeg");
    expect(props.medium).toBe("podcast");
  });

  it("writes its own family by default, keeping what core cannot hold", async () => {
    const h = harness({
      responses: { "https://feeds.example/show": [feedResponse(feedXml(1))] },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    const props = h.bulkCalls[0]?.inputs[0]?.properties ?? {};
    expect(props.enclosure_type).toBe("audio/mpeg");
    expect(props.duration_raw).toBe("600");
    expect(props.podcast_guid).toBe("11111111-2222-5333-8444-555555555555");
  });
});

/* ------------------------------------------------------------------ */
/* Rotation                                                            */
/* ------------------------------------------------------------------ */

describe("many feeds", () => {
  it("scopes an episode's provenance by its show", async () => {
    // Two feeds emitting the identical bare guid must not collide.
    const h = harness({
      feedUrls: ["https://feeds.example/a", "https://feeds.example/b"],
      responses: {
        "https://feeds.example/a": [feedResponse(feedXml(1, "shared"))],
        "https://feeds.example/b": [
          feedResponse(
            feedXml(1, "shared").replace(
              "11111111-2222-5333-8444-555555555555",
              "99999999-2222-5333-8444-555555555555",
            ),
          ),
        ],
      },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    const ids = h.bulkCalls.flatMap((c) => c.inputs.map((i) => i.source_id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(2);
  });

  it("surfaces a feed that asks to be followed elsewhere, without following it", async () => {
    const xml = feedXml(1).replace(
      "<link>https://example.com</link>",
      "<link>https://example.com</link><itunes:new-feed-url>https://elsewhere.example/feed</itunes:new-feed-url>",
    );
    const h = harness({
      responses: { "https://feeds.example/show": [feedResponse(xml)] },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    expect(
      h.activity.some(
        (a) =>
          a.severity === "action_required" && a.summary.includes("new address"),
      ),
    ).toBe(true);
    // Following an address a document hands you is an open redirect.
    expect(h.fetched.map((f) => f.url)).not.toContain(
      "https://elsewhere.example/feed",
    );
  });
});
