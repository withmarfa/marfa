import { familyOnlyMappingResolver } from "@withmarfa/runtime-sdk";
import { MAX_FILTER_INPUT_LENGTH } from "@withmarfa/shared";
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
  /** Mutable so a test can fail a join on one tick and let it
   *  succeed on the next, which is the whole retry property. */
  ensureEdgeThrows?: boolean;
  configReadThrows?: boolean;
  cursors?: Record<string, unknown>;
  /** How many episode rows a `listItems` lookup finds. Defaults to one,
   *  because the stale-checkpoint check only fires on none. */
  storedEpisodes?: number;
  /** Overrides `storedEpisodes` per item state. */
  storedEpisodesByState?: Record<string, number>;
  /** Overrides both, per episode type and then per item state. */
  storedEpisodesByType?: Record<string, Record<string, number>>;
  /** Throw from `activity.emit` on summaries matching this. */
  activityThrowsOn?: (summary: string) => boolean;
  listItemsThrows?: boolean;
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
  const listQueries: {
    type?: string;
    filter?: string;
    state?: string;
    limit?: number;
  }[] = [];
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
    async listItems(query: {
      type?: string;
      filter?: string;
      state?: string;
      limit?: number;
    }) {
      listQueries.push(query);
      if (opts.listItemsThrows === true) throw new Error("list failed");
      // Keyed by type first, then by state, so a test can put a show's
      // episodes under the other write family or in the trash and still say
      // they exist.
      const byType = opts.storedEpisodesByType?.[query.type ?? ""];
      const count =
        byType?.[query.state ?? "active"] ??
        (byType === undefined
          ? (opts.storedEpisodesByState?.[query.state ?? "active"] ??
            (query.state === "active" ? (opts.storedEpisodes ?? 1) : 0))
          : 0);
      return {
        data: Array.from({ length: count }, (_, i) => ({
          id: `stored-${String(i)}`,
        })),
        cursor: null,
        has_more: false,
      };
    },
  };

  const ctx = {
    connection_id: "conn-1",
    integration_name: "marfa/podcasts",
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
        if (opts.activityThrowsOn?.(a.summary) === true) {
          throw new Error("activity emit failed");
        }
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
    listQueries,
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

function feedXml(
  episodes: number,
  guidPrefix = "ep",
  showGuid = "11111111-2222-5333-8444-555555555555",
): string {
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
  <podcast:guid>${showGuid}</podcast:guid>
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
    // Held forever, one bad episode makes every tick re-walk the catalog.
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

    expect(h.created[0]?.type).toBe("marfa.podcast.show");
    expect(h.bulkCalls[0]?.inputs[0]?.type).toBe("marfa.podcast.episode");
  });

  it("retries a failed join on the next tick instead of orphaning it", async () => {
    // The defect this replaces: the join was attempted only on the tick
    // that created the episode. A failure emitted a row, but the episode
    // was still counted as written and still entered the remembered-ids
    // ring, so it was never offered again and the edge could never form.
    // One transient refusal orphaned a member permanently.
    const opts = {
      responses: {
        "https://feeds.example/show": [
          feedResponse(feedXml(1)),
          feedResponse(feedXml(1)),
        ],
      },
      ensureEdgeThrows: true,
    };
    const h = harness(opts);
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    // Parked rather than reported: a first failure is not yet a person's
    // problem, because the next tick is going to try again.
    const parked = [...h.store.values()].find(
      (c): c is { pending_joins?: string[] } =>
        typeof c === "object" && c !== null && "pending_joins" in c,
    );
    expect(parked?.pending_joins ?? []).toHaveLength(1);
    expect(h.activity.some((a) => a.summary.includes("not joined"))).toBe(
      false,
    );

    // Second tick, with the edge now accepted. The episode is already
    // remembered, so the sweep will not offer it — the drain is the only
    // thing that can repair it.
    opts.ensureEdgeThrows = false;
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    expect(h.edges.length).toBeGreaterThan(0);
    const stillParked = [...h.store.values()].find(
      (c): c is { pending_joins?: string[] } =>
        typeof c === "object" && c !== null && "pending_joins" in c,
    );
    expect(stillParked?.pending_joins ?? []).toHaveLength(0);
  });

  it("reports only once the retry has also failed", async () => {
    const h = harness({
      responses: {
        "https://feeds.example/show": [
          feedResponse(feedXml(1)),
          feedResponse(feedXml(1)),
        ],
      },
      ensureEdgeThrows: true,
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    expect(
      h.activity.some(
        (a) =>
          a.severity === "action_required" &&
          a.summary.includes("still not joined to their show"),
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
      h.created.filter((c) => c.type === "marfa.podcast.show"),
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
    // Kept, not deleted: re-adding must not replay the back catalog.
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

/* ------------------------------------------------------------------ */
/* A checkpoint that outlived the rows it refers to                     */
/* ------------------------------------------------------------------ */

/** A first sweep that writes everything, so the ring is full and real. */
async function sweptOnce(
  opts: { etag?: string } = {},
): Promise<Record<string, unknown>> {
  const first = harness({
    responses: {
      "https://feeds.example/show": [
        feedResponse(
          feedXml(3),
          opts.etag === undefined ? {} : { headers: { etag: opts.etag } },
        ),
      ],
    },
  });
  await createScheduleHandler({ fetch: first.fetchImpl })(first.ctx, MSG);
  const carried: Record<string, unknown> = {};
  for (const [k, v] of first.store) carried[k] = v;
  return carried;
}

const REPORT = "remembers episodes the space no longer has";

function reports(activity: { summary: string }[]): { summary: string }[] {
  return activity.filter((a) => a.summary.includes(REPORT));
}

describe("a ring that remembers episodes the space does not have", () => {
  it("says so, and leaves the checkpoint alone", async () => {
    // The shape that swept hourly for three days and imported nothing. It
    // reports rather than repairing, because "no rows anywhere" cannot tell
    // rows that were lost from rows somebody deleted: a trashed item is
    // purged when its retention expires, and after that the two look the
    // same. Re-importing a catalog somebody deleted is the worse fault.
    const carried = await sweptOnce();
    const h = harness({
      cursors: carried,
      storedEpisodes: 0,
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(3))],
      },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    const said = h.activity.filter((a) => a.summary.includes(REPORT));
    expect(said).toHaveLength(1);
    expect(said[0]?.severity).toBe("action_required");
    expect(said[0]?.detail).toMatchObject({ remembered: 3 });
    expect(said[0]?.detail?.remedy).toBe(
      "reinstall the connection to re-import the feed",
    );
    // Precise about what stops. A newly published episode is not in the ring
    // and imports normally; it is the back catalog that does not return.
    expect(said[0]?.summary).toContain("back catalog will not be re-imported");

    const last = feedCursors(h.cursorWrites).at(-1)?.value;
    expect(last?.recent_entry_ids).toHaveLength(3);
  });

  it("still says so when the feed answers 304", async () => {
    // The case a check further down would miss entirely. A feed that serves
    // an ETag answers 304 and the sweep returns before it looks at any
    // episode, so a stuck connection on such a feed would never be noticed.
    const carried = await sweptOnce({ etag: '"v1"' });
    const h = harness({
      cursors: carried,
      storedEpisodes: 0,
      responses: {
        "https://feeds.example/show": [feedResponse("", { status: 304 })],
      },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    expect(reports(h.activity)).toHaveLength(1);
    expect(h.bulkCalls).toHaveLength(0);
  });

  it("says it once, not every hour", async () => {
    const carried = await sweptOnce();
    const h = harness({
      cursors: carried,
      storedEpisodes: 0,
      responses: {
        "https://feeds.example/show": [
          feedResponse(feedXml(3)),
          feedResponse(feedXml(3)),
        ],
      },
    });
    const handler = createScheduleHandler({ fetch: h.fetchImpl });
    await handler(h.ctx, MSG);
    await handler(h.ctx, MSG);

    expect(reports(h.activity)).toHaveLength(1);
  });

  it("clears the marker when an episode lands, so a recurrence can report", async () => {
    // A write means the situation changed, so a later recurrence is a new
    // fact rather than the same one repeated. Against a real server the
    // second report needs a second loss event; the stub holds the space
    // empty throughout, which is what makes the cleared marker observable.
    const carried = await sweptOnce();
    const h = harness({
      cursors: carried,
      storedEpisodes: 0,
      responses: {
        "https://feeds.example/show": [
          feedResponse(feedXml(3)),
          feedResponse(feedXml(4)),
          feedResponse(feedXml(4)),
        ],
      },
    });
    const handler = createScheduleHandler({ fetch: h.fetchImpl });
    await handler(h.ctx, MSG);
    expect(reports(h.activity)).toHaveLength(1);
    await handler(h.ctx, MSG);
    expect(h.bulkCalls.length).toBeGreaterThan(0);
    await handler(h.ctx, MSG);
    expect(reports(h.activity)).toHaveLength(2);
  });

  it("scopes the lookup to this show's own episodes", async () => {
    // An unscoped lookup would find another show's episodes and conclude
    // this one was fine, which would make the check silently useless.
    const carried = await sweptOnce();
    const h = harness({
      cursors: carried,
      storedEpisodes: 0,
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(3))],
      },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    // The literal scope the fixture declares, not merely something
    // scope-shaped: a regression using the wrong key would still match a
    // loose pattern.
    for (const q of h.listQueries) {
      expect(q.filter).toBe(
        'source_id starts_with "ep:11111111-2222-5333-8444-555555555555:"',
      );
      expect(q.limit).toBe(1);
    }
    // The whole sequence, not the distinct set of each column. A set would
    // be satisfied by asking one type for one state and the other for the
    // rest, which is not the same property.
    expect(
      h.listQueries.map((q) => `${q.type ?? ""}/${q.state ?? ""}`),
    ).toEqual([
      "marfa.podcast.episode/active",
      "marfa.podcast.episode/archived",
      "marfa.podcast.episode/trashed",
      "core.media.episode/active",
      "core.media.episode/archived",
      "core.media.episode/trashed",
    ]);
  });

  it("says nothing when the episodes are there", async () => {
    const carried = await sweptOnce();
    const h = harness({
      cursors: carried,
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(3))],
      },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    expect(reports(h.activity)).toHaveLength(0);
    // Stops at the first hit, so the ordinary case costs one lookup rather
    // than six.
    expect(h.listQueries).toHaveLength(1);
  });

  it("says nothing when the episodes are under the other write family", async () => {
    // `write_family` is configurable per connection and the ring does not
    // record which one wrote an entry, so a connection that switched has its
    // episodes under the other type. Checking only the current one would
    // tell somebody to reinstall a connection whose rows are right there.
    const carried = await sweptOnce();
    const h = harness({
      cursors: carried,
      writeFamily: "core",
      storedEpisodesByType: {
        "core.media.episode": { active: 0, archived: 0, trashed: 0 },
        "marfa.podcast.episode": { active: 3 },
      },
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(3))],
      },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    expect(reports(h.activity)).toHaveLength(0);
    // The fall-through, asserted rather than assumed: the connection's own
    // family is asked first and comes back empty in all three states, and
    // the other family is what stops the check.
    expect(
      h.listQueries.map((q) => `${q.type ?? ""}/${q.state ?? ""}`),
    ).toEqual([
      "core.media.episode/active",
      "core.media.episode/archived",
      "core.media.episode/trashed",
      "marfa.podcast.episode/active",
    ]);
  });

  it("warns again after a lookup recovers and then fails once more", async () => {
    // The failure marker is cleared by the next lookup that succeeds, so a
    // second outage is a second fact rather than the same one suppressed.
    const carried = await sweptOnce();
    const failing = harness({
      cursors: carried,
      listItemsThrows: true,
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(3))],
      },
    });
    await createScheduleHandler({ fetch: failing.fetchImpl })(failing.ctx, MSG);
    const afterFailure: Record<string, unknown> = {};
    for (const [k, v] of failing.store) afterFailure[k] = v;

    // A tick where the lookup works and finds the episodes.
    const healthy = harness({
      cursors: afterFailure,
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(3))],
      },
    });
    await createScheduleHandler({ fetch: healthy.fetchImpl })(healthy.ctx, MSG);
    const afterRecovery: Record<string, unknown> = {};
    for (const [k, v] of healthy.store) afterRecovery[k] = v;

    const h = harness({
      cursors: afterRecovery,
      listItemsThrows: true,
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(3))],
      },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    expect(
      h.activity.filter((a) => a.summary.includes("could not check")),
    ).toHaveLength(1);
  });

  it("says nothing when the episodes were put in the trash", async () => {
    // Somebody who trashed a show's episodes still has them.
    const carried = await sweptOnce();
    const h = harness({
      cursors: carried,
      storedEpisodesByState: { active: 0, archived: 0, trashed: 3 },
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(3))],
      },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    expect(reports(h.activity)).toHaveLength(0);
  });

  it("refuses an identifier too long to ask about, and says so", async () => {
    // Declared guids come from third-party XML. The filter grammar caps its
    // input, so a long enough one would throw on every tick forever.
    // Refused here instead, once, on its own marker.
    //
    // A backslash is deliberately not refused: the grammar escapes quotes
    // and consumes any other backslash literally, and the one shape it
    // cannot express is a value ending in one, which the trailing colon on
    // every prefix rules out.
    const enormous = "a".repeat(2100);
    const first = harness({
      responses: {
        "https://feeds.example/show": [
          feedResponse(feedXml(3, "ep", enormous)),
        ],
      },
    });
    await createScheduleHandler({ fetch: first.fetchImpl })(first.ctx, MSG);
    const carried: Record<string, unknown> = {};
    for (const [k, v] of first.store) carried[k] = v;

    const h = harness({
      cursors: carried,
      storedEpisodes: 0,
      responses: {
        "https://feeds.example/show": [
          feedResponse(feedXml(3, "ep", enormous)),
        ],
      },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    // No lookup attempted, and no false finding either.
    expect(h.listQueries).toHaveLength(0);
    expect(reports(h.activity)).toHaveLength(0);
    const refused = h.activity.filter((a) =>
      a.summary.includes("too long to ask about"),
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]?.severity).toBe("warning");
  });

  it("asks about an identifier carrying quotes and backslashes", async () => {
    // The grammar consumes a backslash literally unless it precedes a
    // quote, so escaping quotes alone round-trips every value. Refusing on
    // a backslash, which an earlier revision did, would have switched the
    // detector off for any feed whose declared identifier contained one.
    const awkward = 'a\\b"c';
    const first = harness({
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(3, "ep", awkward))],
      },
    });
    await createScheduleHandler({ fetch: first.fetchImpl })(first.ctx, MSG);
    const carried: Record<string, unknown> = {};
    for (const [k, v] of first.store) carried[k] = v;

    const h = harness({
      cursors: carried,
      storedEpisodes: 0,
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(3, "ep", awkward))],
      },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    // Asked about rather than refused, and the quote is escaped.
    expect(h.listQueries.length).toBeGreaterThan(0);
    expect(h.listQueries[0]?.filter).toContain('\\"');
    expect(reports(h.activity)).toHaveLength(1);
  });

  it("asks at the grammar's limit and refuses one character past it", async () => {
    // Pins the boundary rather than a number well clear of it. The cap the
    // grammar enforces is the one this checks against, imported rather than
    // copied, so the two cannot drift.
    const overhead = 'source_id starts_with "ep::"'.length;
    const exact = "a".repeat(MAX_FILTER_INPUT_LENGTH - overhead);

    for (const [guid, expectLookup] of [
      [exact, true],
      [exact + "a", false],
    ] as const) {
      const first = harness({
        responses: {
          "https://feeds.example/show": [feedResponse(feedXml(3, "ep", guid))],
        },
      });
      await createScheduleHandler({ fetch: first.fetchImpl })(first.ctx, MSG);
      const carried: Record<string, unknown> = {};
      for (const [k, v] of first.store) carried[k] = v;

      const h = harness({
        cursors: carried,
        storedEpisodes: 0,
        responses: {
          "https://feeds.example/show": [feedResponse(feedXml(3, "ep", guid))],
        },
      });
      await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);
      expect(h.listQueries.length > 0).toBe(expectLookup);
    }
  });

  it("still reports a finding after a lookup has failed once", async () => {
    // The two markers are separate on purpose. Sharing one meant a single
    // transient error suppressed the finding for the life of the cursor,
    // and on a feed that is genuinely stuck nothing ever clears it, because
    // the thing that clears it is an episode landing.
    const carried = await sweptOnce();
    const failing = harness({
      cursors: carried,
      listItemsThrows: true,
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(3))],
      },
    });
    await createScheduleHandler({ fetch: failing.fetchImpl })(failing.ctx, MSG);
    expect(
      failing.activity.filter((a) => a.summary.includes("could not check")),
    ).toHaveLength(1);

    const afterwards: Record<string, unknown> = {};
    for (const [k, v] of failing.store) afterwards[k] = v;

    const h = harness({
      cursors: afterwards,
      storedEpisodes: 0,
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(3))],
      },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    expect(reports(h.activity)).toHaveLength(1);
  });

  it("does not let a failed report wedge the rest of the connection", async () => {
    // The check runs before the fetch and before the index that rotates
    // feeds is advanced. A throw there would leave the same feed at the head
    // of the rotation forever, so every other feed on the connection would
    // stop being swept: a far worse failure than the one it detects.
    const one = "https://feeds.example/show";
    const two = "https://feeds.example/other";
    const seed = harness({
      feedUrls: [one, two],
      responses: {
        [one]: [feedResponse(feedXml(3))],
        [two]: [feedResponse(feedXml(2))],
      },
    });
    await createScheduleHandler({ fetch: seed.fetchImpl })(seed.ctx, MSG);
    const carried: Record<string, unknown> = {};
    for (const [k, v] of seed.store) carried[k] = v;

    const h = harness({
      cursors: carried,
      feedUrls: [one, two],
      storedEpisodes: 0,
      activityThrowsOn: (summary) => summary.includes(REPORT),
      responses: {
        [one]: [feedResponse(feedXml(3))],
        [two]: [feedResponse(feedXml(2))],
      },
    });
    const result = await createScheduleHandler({ fetch: h.fetchImpl })(
      h.ctx,
      MSG,
    );

    expect(result).toEqual({ ok: true });
    // Both feeds were fetched, so the throw on the first did not stop the
    // second.
    expect(new Set(h.fetched.map((f) => f.url))).toEqual(new Set([one, two]));
    // And the rotation index was written. That is the assertion that
    // distinguishes a wedge: the write happens after the sweep loop, so a
    // throw anywhere inside it leaves the index untouched and the same feed
    // at the head of the rotation next tick.
    expect(h.cursorWrites.filter((w) => w.key === "main")).not.toHaveLength(0);
  });

  it("retires the feeds when the last one is removed", async () => {
    // Emptying the configuration used to return before the retirement loop,
    // so every cursor stayed un-retired and orphaned from an index that no
    // longer named it. Adding the feeds back then gave a full ring with its
    // report marker intact and the detector silent, which is the outcome of
    // the most natural way anyone tries to reset a connection.
    // Seeded with the marker actually set, so the clear is observable
    // rather than asserting a value that was already null.
    const carried = await sweptOnce();
    const reported = harness({
      cursors: carried,
      storedEpisodes: 0,
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(3))],
      },
    });
    await createScheduleHandler({ fetch: reported.fetchImpl })(
      reported.ctx,
      MSG,
    );
    expect(reports(reported.activity)).toHaveLength(1);
    const marked: Record<string, unknown> = {};
    for (const [k, v] of reported.store) marked[k] = v;
    expect(
      feedCursors(reported.cursorWrites).at(-1)?.value
        .stale_checkpoint_reported_at,
    ).toBeTruthy();

    const h = harness({ cursors: marked, feedUrls: [], responses: {} });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    const retired = feedCursors(h.cursorWrites).at(-1)?.value;
    expect(retired?.retired_at).toBeTruthy();
    expect(retired?.stale_checkpoint_reported_at).toBeNull();
    expect(retired?.checkpoint_lookup_failed_at).toBeNull();
  });

  it("reports a lookup it could not perform, rather than going quiet", async () => {
    // A detector that switches itself off on an error is the failure this
    // whole check exists against, one level up.
    const carried = await sweptOnce();
    const h = harness({
      cursors: carried,
      listItemsThrows: true,
      responses: {
        "https://feeds.example/show": [feedResponse(feedXml(3))],
      },
    });
    await createScheduleHandler({ fetch: h.fetchImpl })(h.ctx, MSG);

    expect(reports(h.activity)).toHaveLength(0);
    const warned = h.activity.filter((a) =>
      a.summary.includes("could not check whether"),
    );
    expect(warned).toHaveLength(1);
    expect(warned[0]?.severity).toBe("warning");
  });
});
